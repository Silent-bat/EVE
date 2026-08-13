declare module "ws" {
  export class WebSocket extends EventEmitter {
    static OPEN: number;
    static CLOSED: number;
    static CLOSING: number;
    static CONNECTING: number;
    constructor(url: string | null, options?: any);
    readyState: number;
    send(data: any): void;
    close(code?: number, data?: string): void;
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    off(event: string, listener: (...args: any[]) => void): this;
  }
  export class WebSocketServer extends EventEmitter {
    constructor(options?: any);
    handleUpgrade(request: any, socket: any, head: any, callback: (client: WebSocket) => void): void;
    close(callback?: (err?: Error) => void): void;
  }
}
