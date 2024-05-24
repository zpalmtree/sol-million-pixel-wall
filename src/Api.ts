import express, { Request, Response } from 'express';
import { Server } from 'http';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { match } from 'path-to-regexp';

import { PixelWall } from './PixelWall.js';
import {
    DB,
    RouteData,
    Endpoint,
    ApiMethod,
    ApiRoute,
} from './Types.js';
import { logger } from './Logger.js';
import {
    CORS_WHITELIST,
    SERVER_PORT,
} from './Constants.js';

export class Api {
    private httpServer = express();

    private runningServer: Server | undefined;

    private running: boolean = false;

    private routeData: RouteData[] = [
    ];

    private handlers: ApiRoute[];

    private handlerMap: Map<string, ApiRoute>;

    constructor(
        private pixelWall: PixelWall,
        private db: DB,
    ) {
        this.handlers = this.routeData.map((r) => {
            return {
                ...r,
                routeMatchTest: match(r.path, { decode: decodeURIComponent }),
            };
        });

        this.handlerMap = new Map(this.handlers.map((h) => [`${h.path}-${h.method}`, h]));
    }

    /* This function will take the coordinate to purchase,
     * check they haven't been purchased already,
     * then create transaction(s) transferring the NFT to the
     * user, transferring SOL from the user to us, along
     * with priority fee and jito fee. We then return the
     * partially signed transaction to the frontend */
    public async purchasePixelSquares() {
    }

    /* This function will take the coordinates to update,
     * a signed transaction / on chain transaction hash giving us
     * sol. We will either ensure it lands on chain or validate it
     * is legitimate. A signed message and the public key must be
     * included. We will fetch the NFTs of the user, and verify
     * that they own the NFTs corresponding to the selected pixels.
     * If they do, we will validate the image is valid, split them
     * into blocks corresponding to the image boundaries, and
     * store the image data. We will then invalidate the image cache,
     * and return success to the user */
    public async modifyDefinedPurchasedPixels() {
    }

    /* This function will work the same as modifyDefinedPurchasedPixels, but
     * this function does not cost any SOL to interact with - this is for initially
     * setting the image after the user has already purchased the pixels */
    public async modifyUndefinedPurchasedPixels() {
    }

    /* This function will take a transaction signature as input,
     * validate the transaction is on chain, parse it, verify
     * it is legitimate, mark the pixels as purchased in the DB,
     * and store any related info in the DB */
    public async flagPixelsAsPurchased() {
    }

    /* This function will iterate through the saved pixels / blocks,
     * add them to the fabric js canvas, render the image to file,
     * maybe cache it in some way to avoid multiple renders, and
     * then return the image to the caller. */
    public async renderPixelImage() {
        const renderedImage = this.pixelWall.renderImage();
    }

    public async start() {
        if (!this.running) {
            await this.init();
        }

        this.running = true;

        return new Promise<void>((res) => {
            this.runningServer = this.httpServer.listen(SERVER_PORT, () => res());
        });
    }

    public async stop() {
        if (this.running) {
            await new Promise<void>((res) => {
                if (this.runningServer) {
                    this.runningServer.close(() => res());
                }
            });

            this.running = false;
        }
    }

    /* PRIVATE FUNCTIONS */

    private async init() {
        const corsOptions = {
            origin: function (origin: string | undefined, callback: (err: null | Error, next?: boolean) => void) {
                if (!origin || CORS_WHITELIST.includes(origin) || origin.startsWith('http://localhost')) {
                    callback(null, true)
                } else {
                    logger.error(`Request with origin of ${origin} is not allowed by CORS!`);
                    callback(new Error('Not allowed by CORS'))
                }
            }
        }

        this.httpServer.set('trust proxy', true);

        /* Enable cors for requests */
        this.httpServer.use(cors(corsOptions));

        /* Enable cors for all options requests */
        this.httpServer.options('*', cors(corsOptions));

        /* Log request info */
        this.httpServer.use(this.asyncWrapper(this.loggingMiddleware.bind(this)));

        /* API Key middleware etc. Note, has to be listed BEFORE handlers */
        this.httpServer.use(this.asyncWrapper(this.guardMiddleware.bind(this)));

        /* Parse bodies as json */
        this.httpServer.use(express.json());

        /* Attach handlers */
        for (const handler of this.handlers) {
            const boundFunc = this.asyncWrapper(handler.routeImplementation.bind(this, this.db));

            switch (handler.method) {
                case ApiMethod.GET: {
                    this.httpServer.get(handler.path, boundFunc);
                    break;
                }
                case ApiMethod.POST: {
                    this.httpServer.post(handler.path, boundFunc);
                    break;
                }
                case ApiMethod.DELETE: {
                    this.httpServer.delete(handler.path, boundFunc);
                    break;
                }
                default: {
                    throw new Error(`Unsupported method type ${handler.method} in attachHandlers!`);
                    break;
                }
            }
        }

        /* Error handler. Note, has to be listed AFTER handlers. Also, only catches synchronous errors. */
        this.httpServer.use((err: any, req: Request, res: Response, _next: (err?: any) => void) => {
            if (err.query) {
                logger.error(err, err.query);
            } else {
                logger.error(err);
            }

            res.status(500).send({
                error: err.toString(),
            });
        });
    }

    /* Handles catching rejected promises and sending them to the error handler */
    private asyncWrapper(fn: (req: Request, res: Response, next: (err?: any) => void) => void) {
        return (req: Request, res: Response, next: (err?: any) => void) => {
            Promise.resolve(fn(req, res, next)).catch(next);
        };
    }

    private async guardMiddleware(req: Request, res: Response, next: (err?: any) => void) {
        /* OPTIONS requests do not include credentials, we need to permit them
         * regardless */
        if (req.method === 'OPTIONS') {
            next();
            return;
        }

        let path = undefined;
        let routeInfo = undefined;

        for (const handler of this.handlers) {
            if (handler.routeMatchTest(req.path) && handler.method === req.method) {
                path = handler.path;
                routeInfo = handler;
                break;
            }
        }

        if (!routeInfo || req.method !== routeInfo.method || !path) {
            res.status(404).send({
                error: 'Unknown route',
            });

            return;
        }

        if (routeInfo.guards) {
            for (const guard of routeInfo.guards) {
                const {
                    accessPermitted,
                    error,
                    statusCode,
                } = await guard(req, res, path, req.method, this.db);

                if (!accessPermitted) {
                    res.status(statusCode!).send({
                        error: error!,

                    });

                    return;
                }
            }
        }

        next();
    }

    private async loggingMiddleware(req: Request, res: Response, next: (err?: any) => void) {
        let ip = req.ip!;

        if (ip.substr(0, 7) == '::ffff:') { // fix for if you have both ipv4 and ipv6
            ip = ip.substr(7);
        }

        logger.info(`Recieved request for ${req.method} ${req.path} from ${ip}`);

        next();
    }

}
