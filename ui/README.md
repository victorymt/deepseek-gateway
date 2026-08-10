# DeepSeek Gateway UI

React + TypeScript + Vite + shadcn/ui dashboard for the gateway.

Requires Node.js 20.19+ or 22.12+.

## Development

Start the gateway on port `8787`, then run:

```bash
npm run dev
```

Vite proxies health and authentication requests to the local gateway.

## Production Build

Build before starting the gateway:

```bash
npm run build
```

The gateway serves `ui/dist` automatically when the build exists.
