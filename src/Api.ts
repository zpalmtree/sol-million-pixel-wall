import express, { Request, Response } from 'express';
import { Server } from 'http';
import cors from 'cors';
import { match } from 'path-to-regexp';
import fetch from 'node-fetch';
import * as fs from 'fs/promises';
import * as url from 'url';
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
    ConcurrentMerkleTreeAccount,
} from "@solana/spl-account-compression";
import {
    createTransferInstruction,
} from "@metaplex-foundation/mpl-bubblegum";
import bs58 from 'bs58';
import { v4 as uuidv4 } from 'uuid';
import {
    StaticCanvas,
    Image,
} from 'fabric/node';

import { WrappedConnection } from './WrappedConnection.js';
import { PixelWall } from './PixelWall.js';
import {
    DB,
    RouteData,
    ApiMethod,
    ApiRoute,
    Coordinate,
    Brick,
    BrickImage,
    BrickInfo,
} from './Types.js';
import { logger } from './Logger.js';
import {
    CORS_WHITELIST,
    JITO_TIP_ACCOUNTS,
    JITO_FEE,
    SERVER_PORT,
    PRICE_PER_BRICK,
    FUNDS_DESTINATION,
    BRICK_WIDTH,
    BRICK_HEIGHT,
    CANVAS_WIDTH,
    CANVAS_HEIGHT,
} from './Constants.js';
import {
    pickRandomItem,
    getBubblegumAuthorityPDA,
    bufferToArray,
    verifySignature,
    sleep,
} from './Utils.js';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

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
            path: '/info',
            routeImplementation: this.getWallInfo,
            method: ApiMethod.GET,
            description: 'Get an image of the wall, along with purchased pixels info',
        },
        {
            path: '/owned',
            routeImplementation: this.getUserPixels,
            method: ApiMethod.POST,
            description: 'Get pixels owned by a specific user',
        },
    ];

    private handlers: ApiRoute[];

    private handlerMap: Map<string, ApiRoute>;

    private cachedImage: string | undefined;

    private cachedBricks: BrickInfo[] | undefined = undefined; 

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
            let userPublicKey: PublicKey;

            try {
                userPublicKey = new PublicKey(solAddress);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid SOL address provided.' });
            }

            const selectedBricks: Coordinate[] = coordinates;

            // Generate placeholders for each coordinate
            const conditions = selectedBricks.map((_, index) =>
                `($${index * 2 + 1}, $${index * 2 + 2})`
            ).join(', ');

            // Flatten the coordinates into a single array of values
            const values = selectedBricks.flatMap(coord => [coord.x, coord.y]);

            // Construct the query with the generated placeholders
            const query = `
                SELECT
                    x,
                    y,
                    assetId AS "assetId",
                    purchased 
                FROM
                    wall_bricks 
                WHERE
                    (x, y) IN (${conditions})
            `;

            const bricks = await db.any(query, values);

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

            // Helper function to create a transaction for a brick
            const createTransaction = async (brick: Brick) => {
                const transaction = new Transaction();
                const assetId = brick.assetId;

                transaction.add(this.setComputeUnitLimitInstruction());
                transaction.add(this.setComputeUnitPriceInstruction());
                transaction.add(this.transferSOLInstruction(userPublicKey, new PublicKey(FUNDS_DESTINATION), PRICE_PER_BRICK));
                transaction.add(await this.transferNFTInstruction(assetId, this.keypair, userPublicKey));
                transaction.add(this.jitoTipInstruction(userPublicKey, JITO_FEE));

                transaction.feePayer = userPublicKey;
                transaction.recentBlockhash = recentBlockhash;

                // Sign the transaction with our private key
                transaction.sign(this.keypair);

                const serialized = transaction.serialize({
                    requireAllSignatures: false,
                    verifySignatures: false,
                });

                return serialized.toString('base64');
            };

            // Split bricks into chunks of 100 and process each chunk in parallel
            const chunkSize = 100;
            for (let i = 0; i < bricks.length; i += chunkSize) {
                const chunk = bricks.slice(i, i + chunkSize);

                try {
                    const chunkTransactions = await Promise.all(chunk.map(createTransaction));
                    transactions.push(...chunkTransactions);
                } catch (err: any) {
                    res.status(400).json({
                        error: err.toString(),
                    });

                    return;
                }
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
        return res.status(200).json({
            success: true,
        });
    }

    /* This function will take an array of images, with an x, y, and image key,
     * a sol address, and a signed message "`I am signing this message to confirm that ${publicKey.toString()} can upload images to the million pixel wall`;",
     * this function will verify the signature, verify the pixels exist in the DB and currently all have no image defined,
     * verify the address is holding the NFTs associated with these pixels, using the getDigitalStandardItems API,
     * then store the image data the user uploaded. */
    public async modifyUndefinedPurchasedPixels(db: DB, req: Request, res: Response) {
        const { images, solAddress, signedMessage } = req.body;

        try {
            let userPublicKey: PublicKey;

            try {
                userPublicKey = new PublicKey(solAddress);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid SOL address provided.' });
            }

            // Step 1: Verify the signed message
            const message = `I am signing this message to confirm that ${userPublicKey.toString()} can upload images to the million pixel wall`;

            const isValidSignature = await verifySignature({
                address: solAddress,
                toSign: new TextEncoder().encode(message),
                signature: signedMessage,
            });

            if (!isValidSignature) {
                return res.status(400).json({ error: 'Invalid signature.' });
            }

            // Step 2: Verify that the pixels exist in the DB and currently have no image defined
            const conditions = images.map((_: BrickImage, index: number) =>
                `($${index * 2 + 1}, $${index * 2 + 2})`
            ).join(', ');

            const values = images.flatMap((image: BrickImage) => [image.x, image.y]);

            const query = `
                SELECT
                    x,
                    y,
                    assetId AS "assetId",
                    image_location 
                FROM
                    wall_bricks 
                WHERE
                    (x, y) IN (${conditions})
            `;

            const bricks = await db.any(query, values);

            if (bricks.length !== images.length) {
                return res.status(400).json({ error: 'One or more pixel squares do not exist.' });
            }

            const definedImageBricks = bricks.filter(brick => brick.image_location);
            if (definedImageBricks.length > 0) {
                return res.status(400).json({ error: 'One or more pixel squares already have an image defined.', definedImageBricks });
            }

            // Step 3: Verify the address is holding the NFTs associated with these pixels
            const assetIds = bricks.map(brick => brick.assetId);
            const digitalItems = await this.getDigitalStandardItems(userPublicKey);
            const ownedAssetIds = digitalItems.map(item => item.assetId);

            const missingAssets = assetIds.filter(assetId => !ownedAssetIds.includes(assetId));

            if (missingAssets.length > 0) {
                return res.status(400).json({ error: 'Address does not hold the required NFTs for these pixels.', missingAssets });
            }

            // Step 4: Store the image data on disk and update the database with the image location
            const updateQueries = await Promise.all(images.map(async (image: BrickImage) => {
                const imageName = `${uuidv4()}.png`;
                const imagePath = `${__dirname}../images/${imageName}`;

                // Save the image to disk
                // TODO: Validate size?
                const base64Data = image.image.replace(/^data:image\/png;base64,/, "");
                await fs.writeFile(imagePath, base64Data, 'base64');

                // Update the database with the image location
                return db.none(
                    `UPDATE wall_bricks
                    SET
                        image_location = $1,
                        purchased = TRUE
                    WHERE
                        x = $2
                        AND y = $3`,
                    [ imagePath, image.x, image.y ]
                );
            }));

            await Promise.all(updateQueries);

            this.cachedImage = undefined;

            return res.status(200).json({ success: true });
        } catch (error) {
            logger.error('Error modifying undefined purchased pixels:', error);
            return res.status(500).json({ error: 'Internal server error.' });
        }
    }

    public async getUserPixels(db: DB, req: Request, res: Response) {
        const { solAddress } = req.body;

        try {
            let userPublicKey: PublicKey;

            try {
                userPublicKey = new PublicKey(solAddress);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid SOL address provided.' });
            }

            // Step 1: Verify the address and fetch the user's assets
            const digitalItems = await this.getDigitalStandardItems(userPublicKey);

            if (!digitalItems || digitalItems.length === 0) {
                return res.status(200).json({ success: true, bricks: [] });
            }

            const assetIds = digitalItems.map(item => item.assetId);

            // Step 2: Cross-reference the user's assets with the database to find valid bricks
            const query = `
                SELECT
                    x,
                    y,
                    assetId AS "assetId",
                    image_location IS NULL AS "hasImage"
                FROM
                    wall_bricks
                WHERE
                    assetId IN ($1:csv)
            `;

            const userBricks = await db.any(query, [assetIds]);

            return res.status(200).json({
                success: true,
                bricks: userBricks.map((b) => {
                    return {
                        ...b,
                        name: `${b.x},${b.y}`,
                    };
                }),
            });
        } catch (error) {
            logger.error('Error fetching user pixels:', error);
            return res.status(500).json({ error: 'Internal server error.' });
        }
    }

    /* This function will take a transaction signature as input,
     * validate the transaction is on chain, parse it, verify
     * it is legitimate, mark the pixels as purchased in the DB,
     * and store any related info in the DB */
    public async flagPixelsAsPurchased(db: DB, req: Request, res: Response) {
        return res.status(200).json({
            success: true,
        });
    }

    /* This function will iterate through the saved pixels / blocks,
     * add them to the fabric js canvas, render the image to file,
     * maybe cache it in some way to avoid multiple renders, and
     * then return the image to the caller. It will also return info
     * on bricks that have been purchased. */
    public async getWallInfo(db: DB, req: Request, res: Response) {
        try {
            if (this.cachedImage && this.cachedBricks) {
                return res.status(200).json({
                    image: this.cachedImage,
                    bricks: this.cachedBricks,
                });
            }

            // Query the database to get all pixels/blocks with their purchase and image info
            const query = `
                SELECT x, y, image_location, purchased
                FROM wall_bricks
            `;
            const bricks = await db.any(query);

            const multiplier = 10;

            // Create a Fabric.js canvas
            const canvas = new StaticCanvas(undefined, {
                width: CANVAS_WIDTH * multiplier,
                height: CANVAS_HEIGHT * multiplier,
            });

            // Add each brick with an image to the canvas
            await Promise.all(bricks.map(async (brick) => {
                if (brick.image_location) {
                    const image = await Image.fromURL(`file://${brick.image_location}`);

                    /* Downscale */
                    image.scaleToWidth(BRICK_WIDTH * multiplier);
                    image.scaleToHeight(BRICK_HEIGHT * multiplier);

                    image.set({
                        left: brick.x * BRICK_WIDTH * multiplier,
                        top: brick.y * BRICK_HEIGHT * multiplier,
                        selectable: false,
                        objectCaching: true,
                    });

                    canvas.add(image);
                }
            }));

            // Render the canvas to a data URL
            const dataURL = canvas.toDataURL({
                format: 'png',
                quality: 1.0,
                multiplier: 1,
            });

            const imageData = dataURL.replace(/^data:image\/png;base64,/, '');
            const imagePath = `${__dirname}../images/canvas.png`;
            await fs.writeFile(imagePath, Buffer.from(imageData, 'base64'));

            // Cache the image and bricks info
            this.cachedImage = dataURL;
            this.cachedBricks = bricks.map(brick => ({
                x: brick.x,
                y: brick.y,
                purchased: brick.purchased,
                name: `${brick.x},${brick.y}`,
            }));

            // Return the image and purchased brick information
            return res.status(200).json({
                image: this.cachedImage,
                bricks: this.cachedBricks,
            });
        } catch (error) {
            logger.error('Error getting wall info:', error);
            return res.status(500).json({ error: 'Internal server error.' });
        }
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
        this.httpServer.use(express.json({ limit: '50MB' }));

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

        this.updatePurchasedPixels();
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

        const merkleTree = new PublicKey(assetProof.tree_id);
        const merkleTreeAccountRaw = await this.connection.getAccountInfo(merkleTree);

        if (!merkleTreeAccountRaw) {
            throw new Error('Failed to fetch merkle tree');
        }

        const merkleTreeData = ConcurrentMerkleTreeAccount.fromBuffer(merkleTreeAccountRaw.data);
        const canopyDepth = merkleTreeData.getCanopyDepth();
        const sliceIndex = assetProof.proof.length - canopyDepth;

        const proofPath = assetProof.proof.map((node: string) => ({
            pubkey: new PublicKey(node),
            isSigner: false,
            isWritable: false,
        })).slice(0, sliceIndex);

        const rpcAsset = await this.connectionWrapper.getAsset(assetId);

        if (rpcAsset.ownership.owner !== owner.publicKey.toBase58()) {
            throw new Error('One or more pixel squares are already purchased. Try refreshing the page, your purchase may have already gone through.');
        }

        const leafNonce = rpcAsset.compression.leaf_id;
        const treeAuthority = await getBubblegumAuthorityPDA(merkleTree);
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

    private async getDigitalStandardItems(address: PublicKey): Promise<any[]> {
        let compressedNFTs: any[] = [];

        try {
            let page = 1;

            while (true) {
                const response = await fetch(process.env.RPC_ADDRESS!, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: '1',
                        method: 'getAssetsByOwner',
                        params: {
                            ownerAddress: address.toString(),
                            page,
                            limit: 1000,
                            displayOptions: {
                            },
                        },
                    }),
                });

                if (!response.ok) {
                    console.log(`Failed to fetch compressed NFTs: ${response.status}`);
                    break;
                }

                const rawData = await response.json();

                if (rawData.error) {
                    console.log(`Error fetching compressed NFTs: ${rawData.error.message}`);
                    break;
                }

                const unburnt = rawData?.result?.items?.filter((i: any) => !i.burnt);

                compressedNFTs = compressedNFTs.concat(unburnt.filter((c: any) => c.compression?.compressed));

                /* Are there more pages to fetch? */
                if (rawData.result.total < rawData.result.limit) {
                    break;
                }

                page++;
            }
        } catch (err) {
            console.log(`Error fetching compressed NFTs: ${err}`);
        }
    
        return compressedNFTs.map((c) => {
            return {
                assetId: c.id,
            }
        });
    }

    private async updatePurchasedPixels() {
        while (true) {
            try {
                // Fetch all current assets in the system wallet
                const currentAssets = await this.getDigitalStandardItems(this.keypair.publicKey);
                const currentAssetIdsSet = new Set(currentAssets.map(asset => asset.assetId));

                // Fetch all bricks from the database that are not marked as purchased
                const bricks = await this.db.any(`SELECT * FROM wall_bricks WHERE purchased = FALSE`);

                // Find bricks whose assetIds are not in the currentAssetIdsSet
                const purchasedBricks = bricks.filter(brick => !currentAssetIdsSet.has(brick.assetid));

                if (purchasedBricks.length > 0) {
                    // Update the database to mark these bricks as purchased
                    const assetIdsToUpdate = purchasedBricks.map(brick => brick.assetid);

                    await this.db.none(
                        `UPDATE wall_bricks SET purchased = TRUE WHERE assetid IN ($1:csv)`,
                        [assetIdsToUpdate]
                    );

                    this.cachedBricks = undefined;

                    logger.info(`Updated ${assetIdsToUpdate.length} bricks as purchased.`);
                } else {
                    logger.debug("No bricks to update.");
                }
            } catch (err) {
                logger.error(`Error updating purchased pixels: ${err}`);
            }

            // Sleep for 5 minutes
            await sleep(5 * 60 * 1000);
        }
    }
}
