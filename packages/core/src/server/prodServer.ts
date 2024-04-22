import type { Server } from 'node:http';
import { join } from 'node:path';
import {
  type PreviewServerOptions,
  ROOT_DIST_DIR,
  type RequestHandler,
  type RsbuildConfig,
  type ServerConfig,
  type StartServerResult,
  getAddressUrls,
  getNodeEnv,
  isDebug,
  setNodeEnv,
} from '@rsbuild/shared';
import connect from '@rsbuild/shared/connect';
import sirv from '../../compiled/sirv';
import type { InternalContext } from '../types';
import { formatRoutes, getServerOptions, printServerURLs } from './helper';
import { createHttpServer } from './httpServer';
import {
  faviconFallbackMiddleware,
  getRequestLoggerMiddleware,
} from './middlewares';

type RsbuildProdServerOptions = {
  pwd: string;
  output: {
    path: string;
    assetPrefix?: string;
  };
  serverConfig: ServerConfig;
};

export class RsbuildProdServer {
  private app!: Server;
  private options: RsbuildProdServerOptions;
  public middlewares = connect();

  constructor(options: RsbuildProdServerOptions) {
    this.options = options;
  }

  // Complete the preparation of services
  public async onInit(app: Server) {
    this.app = app;

    await this.applyDefaultMiddlewares();
  }

  private async applyDefaultMiddlewares() {
    const { headers, proxy, historyApiFallback, compress } =
      this.options.serverConfig;

    if (isDebug()) {
      this.middlewares.use(await getRequestLoggerMiddleware());
    }

    // compression should be the first middleware
    if (compress) {
      const { default: compression } = await import(
        '../../compiled/http-compression'
      );
      this.middlewares.use((req, res, next) => {
        compression({
          gzip: true,
          brotli: false,
        })(req, res, next);
      });
    }

    if (headers) {
      this.middlewares.use((_req, res, next) => {
        for (const [key, value] of Object.entries(headers)) {
          res.setHeader(key, value);
        }
        next();
      });
    }

    if (proxy) {
      const { createProxyMiddleware } = await import('./proxy');
      const { middlewares, upgrade } = createProxyMiddleware(proxy);

      for (const middleware of middlewares) {
        this.middlewares.use(middleware);
      }

      this.app.on('upgrade', upgrade);
    }

    this.applyStaticAssetMiddleware();

    if (historyApiFallback) {
      const { default: connectHistoryApiFallback } = await import(
        '../../compiled/connect-history-api-fallback'
      );
      const historyApiFallbackMiddleware = connectHistoryApiFallback(
        historyApiFallback === true ? {} : historyApiFallback,
      ) as RequestHandler;

      this.middlewares.use(historyApiFallbackMiddleware);

      // ensure fallback request can be handled by sirv
      this.applyStaticAssetMiddleware();
    }

    this.middlewares.use(faviconFallbackMiddleware);
  }

  private applyStaticAssetMiddleware() {
    const {
      output: { path, assetPrefix },
      serverConfig: { htmlFallback },
      pwd,
    } = this.options;

    const assetMiddleware = sirv(join(pwd, path), {
      etag: true,
      dev: true,
      ignores: ['favicon.ico'],
      single: htmlFallback === 'index',
    });

    this.middlewares.use((req, res, next) => {
      const url = req.url;

      // handler assetPrefix
      if (assetPrefix && url?.startsWith(assetPrefix)) {
        req.url = url.slice(assetPrefix.length);
        assetMiddleware(req, res, (...args) => {
          req.url = url;
          next(...args);
        });
      } else {
        assetMiddleware(req, res, next);
      }
    });
  }

  public close() {}
}

export async function startProdServer(
  context: InternalContext,
  rsbuildConfig: RsbuildConfig,
  { getPortSilently }: PreviewServerOptions = {},
) {
  if (!getNodeEnv()) {
    setNodeEnv('production');
  }

  const { serverConfig, port, host, https } = await getServerOptions({
    rsbuildConfig,
    getPortSilently,
  });

  const server = new RsbuildProdServer({
    pwd: context.rootPath,
    output: {
      path: rsbuildConfig.output?.distPath?.root || ROOT_DIST_DIR,
      assetPrefix: rsbuildConfig.output?.assetPrefix,
    },
    serverConfig,
  });

  await context.hooks.onBeforeStartProdServer.call();

  const httpServer = await createHttpServer({
    https: serverConfig.https,
    middlewares: server.middlewares,
  });

  await server.onInit(httpServer);

  return new Promise<StartServerResult>((resolve) => {
    httpServer.listen(
      {
        host,
        port,
      },
      async () => {
        const routes = formatRoutes(
          context.entry,
          rsbuildConfig.output?.distPath?.html,
          rsbuildConfig.html?.outputStructure,
        );
        await context.hooks.onAfterStartProdServer.call({
          port,
          routes,
        });

        const protocol = https ? 'https' : 'http';
        const urls = getAddressUrls({ protocol, port });

        printServerURLs({
          urls,
          port,
          routes,
          protocol,
          printUrls: serverConfig.printUrls,
        });

        const onClose = () => {
          server.close();
          httpServer.close();
        };

        resolve({
          port,
          urls: urls.map((item) => item.url),
          server: {
            close: async () => {
              onClose();
            },
          },
        });
      },
    );
  });
}
