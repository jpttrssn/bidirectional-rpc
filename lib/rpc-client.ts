import * as tls from 'tls'
import * as readline from 'readline'
import { EventEmitter } from 'events'
import * as assert from 'assert'
import { Deferred } from './deferred'
import { Observable, Observer, Subscription, throwError } from 'rxjs'

type Question = {
    deferred: Deferred<any>
    timer: NodeJS.Timer
}

export type ResponderFunction = (response: any) => void
export type ObservableResponderFunction = (
    resp: Observable<any> | undefined
) => void

export class RPCClient extends EventEmitter {
    private socket: tls.TLSSocket
    private closed = false
    private rl: readline.ReadLine
    private msgId = 0
    private observableId = 0
    private handler!: RPCClientHandler

    // The local observers in this node that shall get messages emitted
    // by an observable in the peer.
    private observers = new Map<number, Observer<any>>()

    // The subscriptions to local Observables. Each subscription
    // forwards any received values to the peer.
    private subscriptions = new Map<number, Subscription>()
    private outstandingQuestionMap: Map<number, Question> = new Map()
    private initialized = false
    private fingerprint: string | undefined

    /**
     * Create an RPCClient and initiate connection to a server.
     *
     * @param port TCP port number that the server is listening on
     * @param ip IP address that the server is listening on
     * @param token Use this to authenticate to the server
     * @param fingerprint Only connect to the server
     *                    if it presents a certificate with this fingerprint
     */
    constructor(
        handler: RPCClientHandler,
        port: number,
        ip: string,
        token: string,
        fingerprint?: string
    )
    constructor(socket: tls.TLSSocket)
    constructor(
        p1: tls.TLSSocket | RPCClientHandler,
        p2?: number,
        p3?: string,
        p4?: string,
        p5?: string
    ) {
        super()
        if (
            typeof p1 === 'object' &&
            p1 instanceof RPCClientHandler &&
            typeof p2 === 'number' &&
            typeof p3 === 'string' &&
            typeof p4 === 'string'
        ) {
            const token = p4
            this.setHandler(p1)
            this.initialized = true
            this.socket = tls.connect({
                host: p3,
                port: p2,
                rejectUnauthorized: false
            })
            this.socket.on('secureConnect', () => {
                if (this.fingerprint) {
                    if (
                        this.socket.getPeerCertificate().fingerprint !==
                        this.fingerprint
                    ) {
                        this.socket.end()
                        this.handler.onError(
                            new Error('Wrong certificate presented by server')
                        )
                        return
                    }
                }
                this.sendInit(token)
            })
        } else {
            this.socket = p1 as tls.TLSSocket
        }

        this.fingerprint = p5
        this.socket.on('close', (had_error: boolean) => {
            this.closed = true
            this.subscriptions.forEach(subscription =>
                subscription.unsubscribe()
            )
            this.subscriptions = new Map()
            this.observers.forEach(observer => observer.complete())
            this.observers = new Map()
            if (this.handler) {
                this.handler.onClose(had_error)
            }
        })

        this.socket.on('error', (err: Error) => {
            if (err.message === 'socket hang up') {
                // Other end closed connection before we received anything
                // This happens when the client rejects the fingerprint of the client
                this.socket.end()
            } else {
                if (this.handler) {
                    this.handler.onError(err)
                } else {
                    throw err
                }
            }
        })

        this.rl = readline.createInterface({
            input: this.socket,
            output: this.socket
        })
        this.rl.on('line', line => this.receive(line))
    }

    setHandler(handler: RPCClientHandler) {
        this.handler = handler
        handler.initialize(this)
    }

    /**
     * Successfully connected to server
     *
     * @event connect
     */
    on(event: 'connect', listener: () => void): this

    // Internal event used by RPCServer
    on(event: 'initialized', listener: (token: string) => void): this

    /**
     * Event emitted when the RPCClient is closed from either side
     * of the connection or due to an error.
     *
     * @param had_error true if an error caused the RPCClient to be closed
     */
    on(event: 'close', listener: (had_error: boolean) => void): this

    /**
     * Error
     *
     * @param errorMessage
     */
    on(event: 'error', listener: (errorMessage: string) => void): this

    /**
     * A message received from the peer.
     *
     * @param message
     */
    on(event: 'message', listener: (message: any) => void): this

    /**
     * The peer asked a question and expects a response.
     *
     * @param message
     * @param responder A function that shall be called with a response to send
     *                  to the remote client
     */
    on(
        event: 'ask',
        listener: (message: any, responder: ResponderFunction) => void
    ): this

    /**
     * The peer wants an observable
     *
     * @param message A description of the observable that the peer wants
     * @param responder A function that shall be called with an observable
     *                  that emits values to send to the peer.
     */
    on(
        event: 'requestObservable',
        listener: (message: any, responder: ObservableResponderFunction) => void
    ): this

    on(event: string, listener: (...args: any[]) => void) {
        return super.on(event, listener)
    }

    /**
     * Send a message to the peer without asking for a response
     *
     * @param message
     */
    sendMessage(message: any) {
        this.send('msg', message)
    }

    /**
     * Ask the peer a question and expect a response
     * Returns a promise that resolves with the response or
     * rejects if no response is received within the timeout.
     *
     * @param message
     * @param timeout
     */
    ask(message: any, timeout: number = 2000): Promise<any> {
        let deferred = new Deferred()
        let id = this.msgId++
        let timer = global.setTimeout(() => {
            deferred.reject('timeout')
        }, timeout)
        this.outstandingQuestionMap.set(id, { deferred, timer })
        this.send('ask', message, id)
        return deferred.promise
    }

    /**
     * Request an observable from the peer.
     *
     * Note that a cold observable is returned. This means that
     * no request has actually been sent to the peer. It will
     * be sent when someone subscribes to the observable.
     *
     * @param message
     */
    requestObservable(message: any): Observable<any> {
        message = clone(message)

        return new Observable<any>(observer => {
            let observableId = this.observableId++
            this.observers.set(observableId, observer)
            this.send('subscribeObservable', message, observableId)
            return () => {
                if (!this.closed) {
                    // If the socket is closed, the observer will be deleted
                    // in the on('close') and we cannot send messages.
                    if (this.observers.has(observableId)) {
                        // The observer no longer wants to receive more values
                        this.observers.delete(observableId)
                        this.send('cancelObservable', {}, observableId)
                    }
                }
            }
        })
    }

    /**
     * Number of outstanding questions to the peer
     *
     */
    outstandingQuestions(): number {
        return this.outstandingQuestionMap.size
    }

    /**
     * Close the session. A 'close' event will be emitted in both
     * the local and the remote RPCClient.
     *
     */
    close() {
        this.socket.end()
    }

    _accept() {
        assert(!this.initialized)
        this.initialized = true
        this.handler.onConnect()
        this.send('accepted')
    }

    _deny() {
        assert(!this.initialized)
        this.send('denied')
        this.socket.end()
    }

    _observers() {
        return this.observers.size
    }

    _subscriptions() {
        return this.subscriptions.size
    }

    private send(type: string, data?: any, id?: number) {
        this.socket.write(
            JSON.stringify({
                t: type,
                d: data,
                id // If id is undefined it is not represented in json
            }) + '\n'
        )
    }

    private sendInit(token: string) {
        this.send('init', token)
    }

    private respond(id: number, message: any) {
        this.socket.write(
            JSON.stringify({
                t: 'resp',
                id,
                d: message
            }) + '\n'
        )
    }

    private receive(line: string) {
        let data = JSON.parse(line)
        if (!this.initialized) {
            if (data.t === 'init') {
                this.emit('initialized', data.d)
            }
        } else {
            switch (data.t) {
                case 'accepted':
                    this.handler.onConnect()
                    break
                case 'denied':
                    this.handler.onError(new Error('Connection not accepted'))
                    this.socket.end()
                    break
                case 'msg':
                    this.handler.onMessage(data.d)
                    break
                case 'ask':
                    this.handler
                        .onQuestion(data.d)
                        .then(response => {
                            this.respond(data.id, response)
                        })
                        .catch(() => {
                            // TODO: Handle reject from onQuestion
                        })
                    break
                case 'resp':
                    let question = this.outstandingQuestionMap.get(data.id)
                    if (!question) {
                        this.emit(
                            'error',
                            'Response received for unknown id ' + data.id
                        )
                    } else {
                        question.deferred.resolve(data.d)
                        global.clearTimeout(question.timer)
                        this.outstandingQuestionMap.delete(data.id)
                    }
                    break
                case 'obs': // Data for an observable from peer
                    {
                        let observableId = data.id
                        let value = data.d
                        let observer = this.observers.get(observableId)
                        if (observer) {
                            observer.next(value)
                        }
                    }
                    break

                case 'obsComplete': // An observable completed on the peer
                    {
                        let observableId = data.id
                        let observer = this.observers.get(observableId)
                        if (observer) {
                            this.observers.delete(observableId)
                            observer.complete()
                        }
                    }
                    break

                case 'subscribeObservable':
                    {
                        // The peer wants to subscribe to an observable
                        let peerObservableId = data.id
                        let obs = this.handler.onRequestObservable(data.d)
                        if (!obs) {
                            // TODO: Create an observable that only emits an error
                            obs = throwError('Cannot create observable')
                        }

                        let subscription = obs.subscribe(
                            value => this.send('obs', value, peerObservableId),
                            undefined, // TODO: Handle errors
                            () => {
                                if (!this.closed) {
                                    this.send(
                                        'obsComplete',
                                        undefined,
                                        peerObservableId
                                    )
                                    this.subscriptions.delete(peerObservableId)
                                }
                            }
                        )
                        this.subscriptions.set(peerObservableId, subscription)
                    }
                    break

                case 'cancelObservable':
                    {
                        // The peer wants to cancel a subscription
                        let peerObservableId = data.id
                        let subscription = this.subscriptions.get(
                            peerObservableId
                        )
                        if (subscription) {
                            this.subscriptions.delete(peerObservableId)
                            subscription.unsubscribe()
                        } else {
                            // The observable was probably unsubscribed and
                            // completed at the same time
                        }
                    }
                    break

                default:
                    throw `Unexpected data ${data.t}`
            }
        }
    }
}

export class RPCClientHandler {
    constructor() {}
    client: RPCClient

    initialize(client: RPCClient) {
        // TODO: Could there be a circular reference which
        // leads to a leak here?
        this.client = client
        // this.onConnect()
    }

    onConnect() {}

    onClose(_had_error: boolean) {}
    onMessage(_message: any) {}

    onQuestion(_question: any): Promise<any> {
        return Promise.reject()
    }

    onRequestObservable(_params: any): Observable<any> | undefined {
        return undefined
    }

    onError(err: Error) {
        throw err
    }
}

function clone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj))
}
