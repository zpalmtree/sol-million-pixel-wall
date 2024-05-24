import express, { Request, Response } from 'express';
import { Server } from 'http';
import cors from 'cors';
import { match } from 'path-to-regexp';
import {
    Transaction,
    SystemProgram,
    PublicKey,
    Keypair,
    Connection,
    ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
} from "@solana/spl-account-compression";
import {
  createTransferInstruction,
} from "@metaplex-foundation/mpl-bubblegum";
import bs58 from 'bs58';

import { WrappedConnection } from './WrappedConnection';
import { PixelWall } from './PixelWall.js';
import {
    DB,
    RouteData,
    ApiMethod,
    ApiRoute,
    Coordinate,
} from './Types.js';
import { logger } from './Logger.js';
import {
    CORS_WHITELIST,
    JITO_TIP_ACCOUNTS,
    JITO_FEE,
    SERVER_PORT,
    PRICE_PER_BRICK,
} from './Constants.js';
import {
    pickRandomItem,
    getBubblegumAuthorityPDA,
    bufferToArray,
} from './Utils.js';

export class Api {
    private httpServer = express();

    private runningServer: Server | undefined;

    private running: boolean = false;

    private routeData: RouteData[] = [
        {
            path: '/purchase',
            routeImplementation: this.purchasePixelSquares,
            method: ApiMethod.POST,
            description: 'Get transaction to purchase pixel squares',
        },
        {
            path: '/image',
            routeImplementation: this.modifyDefinedPurchasedPixels,
            method: ApiMethod.PUT,
            description: 'Update image data of pixels owned by user',
        },
        {
            path: '/image',
            routeImplementation: this.modifyUndefinedPurchasedPixels,
            method: ApiMethod.POST,
            description: 'Create image data of pixels owned by user',
        },
        {
            path: '/purchase-complete',
            routeImplementation: this.flagPixelsAsPurchased,
            method: ApiMethod.POST,
            description: 'Flag the pixels as purchased',
        },
        {
            path: '/wall',
            routeImplementation: this.getWallImage,
            method: ApiMethod.GET,
            description: 'Get an image of the current pixel wall',
        },
    ];

    private handlers: ApiRoute[];

    private handlerMap: Map<string, ApiRoute>;

    constructor(
        private pixelWall: PixelWall,
        private db: DB,
        private keypair: Keypair,
        private connection: Connection,
        private connectionWrapper: WrappedConnection,
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
    public async purchasePixelSquares(db: DB, req: Request, res: Response) {
        const { coordinates, solAddress } = req.body;

        try {
            let userPublicKey;

            try {
                userPublicKey = new PublicKey(solAddress);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid SOL address provided.' });
            }

            // Verify all bricks exist and are available for purchase
            const query = `SELECT x, y, assetId, purchased FROM wall_bricks WHERE (x, y) IN ($1:csv)`;
            const values = coordinates.map((coord: Coordinate) => `(${coord.x}, ${coord.y})`).join(', ');
            const bricks = await db.any(query, [values]);

            if (bricks.length !== coordinates.length) {
                return res.status(400).json({ error: 'One or more pixel squares do not exist.' });
            }

            const unavailableBricks = bricks.filter(brick => brick.purchased);

            if (unavailableBricks.length > 0) {
                return res.status(400).json({ error: 'One or more pixel squares are already purchased.', unavailableBricks });
            }

            // Create transactions for each coordinate
            const transactions = [];

            const recentBlockhash = (await this.connection.getLatestBlockhash('finalized')).blockhash;

            for (const brick of bricks) {
                const transaction = new Transaction();
                const assetId = brick.assetId;

                transaction.add(this.setComputeUnitLimitInstruction());

                transaction.add(this.setComputeUnitPriceInstruction());

                transaction.add(
                    this.transferSOLInstruction(
                        userPublicKey,
                        this.keypair.publicKey,
                        PRICE_PER_BRICK,
                    )
                );

                transaction.add(
                    await this.transferNFTInstruction(
                        assetId,
                        this.keypair,
                        userPublicKey
                    )
                );

                transaction.add(
                    this.jitoTipInstruction(
                        userPublicKey,
                        JITO_FEE,
                    )
                );

                transaction.feePayer = userPublicKey;
                transaction.recentBlockhash = recentBlockhash;

                // Sign the transaction with our private key
                transaction.sign(this.keypair);

                transactions.push(transaction.serialize({ requireAllSignatures: false }).toString('base64'));
            }

            res.status(200).json({ transactions });
        } catch (error) {
            logger.error('Error purchasing pixel squares:', error);
            res.status(500).json({ error: 'Internal server error.' });
        }
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
    public async modifyDefinedPurchasedPixels(db: DB, req: Request, res: Response) {
    }

    /* This function will work the same as modifyDefinedPurchasedPixels, but
     * this function does not cost any SOL to interact with - this is for initially
     * setting the image after the user has already purchased the pixels */
    public async modifyUndefinedPurchasedPixels(db: DB, req: Request, res: Response) {
    }

    /* This function will take a transaction signature as input,
     * validate the transaction is on chain, parse it, verify
     * it is legitimate, mark the pixels as purchased in the DB,
     * and store any related info in the DB */
    public async flagPixelsAsPurchased(db: DB, req: Request, res: Response) {
    }

    /* This function will iterate through the saved pixels / blocks,
     * add them to the fabric js canvas, render the image to file,
     * maybe cache it in some way to avoid multiple renders, and
     * then return the image to the caller. */
    public async getWallImage(db: DB, req: Request, res: Response) {
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
                case ApiMethod.PUT: {
                    this.httpServer.put(handler.path, boundFunc);
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

    private setComputeUnitLimitInstruction() {
        return ComputeBudgetProgram.setComputeUnitLimit({
            units: 100_000,
        });
    }

    private setComputeUnitPriceInstruction() {
        return ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: 100_000,
        });
    }

    private transferSOLInstruction(from: PublicKey, to: PublicKey, amount: number) {
        return SystemProgram.transfer({
            fromPubkey: from,
            toPubkey: to,
            lamports: amount
        });
    }

    private jitoTipInstruction(
        publicKey: PublicKey,
        lamports: number,
    ) {
        const toPubkey = new PublicKey(pickRandomItem(JITO_TIP_ACCOUNTS));

        return SystemProgram.transfer({
            fromPubkey: publicKey,
            lamports,
            toPubkey,
        });
    }

    private async transferNFTInstruction(
        assetId: string,
        owner: Keypair,
        newOwner: PublicKey,
    ) {
        const assetProof = await this.connectionWrapper.getAssetProof(assetId);

        if (!assetProof?.proof || assetProof.proof.length === 0) {
            throw new Error("Proof is empty");
        }

        const proofPath = assetProof.proof.map((node: string) => ({
            pubkey: new PublicKey(node),
            isSigner: false,
            isWritable: false,
        }));

        const rpcAsset = await this.connectionWrapper.getAsset(assetId);

        if (rpcAsset.ownership.owner !== owner.publicKey.toBase58()) {
            throw new Error(
                `NFT is not owned by the expected owner. Expected ${owner.publicKey.toBase58()} but got ${
                    rpcAsset.ownership.owner
                }.`,
            );
        }

        const leafNonce = rpcAsset.compression.leaf_id;
        const treeAuthority = await getBubblegumAuthorityPDA(
            new PublicKey(assetProof.tree_id),
        );
        const leafDelegate = rpcAsset.ownership.delegate
            ? new PublicKey(rpcAsset.ownership.delegate)
            : new PublicKey(rpcAsset.ownership.owner);

        const transferIx = createTransferInstruction(
            {
                treeAuthority,
                leafOwner: new PublicKey(rpcAsset.ownership.owner),
                leafDelegate: leafDelegate,
                newLeafOwner: newOwner,
                merkleTree: new PublicKey(assetProof.tree_id),
                logWrapper: SPL_NOOP_PROGRAM_ID,
                compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
                anchorRemainingAccounts: proofPath,
            },
            {
                root: bufferToArray(bs58.decode(assetProof.root)),
                dataHash: bufferToArray(
                    bs58.decode(rpcAsset.compression.data_hash.trim()),
                ),
                creatorHash: bufferToArray(
                    bs58.decode(rpcAsset.compression.creator_hash.trim()),
                ),
                nonce: leafNonce,
                index: leafNonce,
            },
        );

        return transferIx;
    }
}
