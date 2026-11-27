declare global {
  interface WebSocketConstructor {
    new (
      url: string | URL,
      protocols?: string | string[] | null,
      options?: { readonly headers?: Record<string, string> },
    ): WebSocket;
  }

  var WebSocket: WebSocketConstructor;
}

export {};
