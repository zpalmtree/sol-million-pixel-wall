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
    TransactionResponse,
    SystemInstruction,
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
    CompressedNFT,
} from './Types.js';
import { logger } from './Logger.js';
import {
    CORS_WHITELIST,
    JITO_TIP_ACCOUNTS,
    JITO_FEE,
    SERVER_PORT,
    PRICE_PER_BRICK,
    PRICE_PER_BRICK_EDIT,
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
    decompileInstruction,
} from './Utils.js';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

export class Api {
    private httpServer = express();

    private runningServer: Server | undefined;

    private running: boolean = false;

    private routeData: RouteData[] = [
        {
            path: '/purchase',
            routeImplementation: this.purchaseBrickSquares,
            method: ApiMethod.POST,
            description: 'Get transaction to purchase bricks',
        },
        {
            path: '/purchase/modify',
            routeImplementation: this.purchaseBrickModify,
            method: ApiMethod.POST,
            description: 'Get transaction to modify brick art',
        },
        {
            path: '/image/modify',
            routeImplementation: this.modifyDefinedPurchasedBricks,
            method: ApiMethod.POST,
            description: 'Modify image data of bricks owned by user',
        },
        {
            path: '/image',
            routeImplementation: this.modifyUndefinedPurchasedBricks,
            method: ApiMethod.POST,
            description: 'Create image data of bricks owned by user',
        },
        {
            path: '/info',
            routeImplementation: this.getWallInfo,
            method: ApiMethod.GET,
            description: 'Get an image of the wall, along with purchased bricks info',
        },
        {
            path: '/owned',
            routeImplementation: this.getUserBricks,
            method: ApiMethod.POST,
            description: 'Get bricks owned by a specific user',
        },
    ];

    private handlers: ApiRoute[];

    private handlerMap: Map<string, ApiRoute>;

    private cachedImage: string | undefined;

    private cachedBricks: BrickInfo[] | undefined = undefined; 

    private cachedImages: { [key: string]: Image } = {};

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

    public async purchaseBrickModify(db: DB, req: Request, res: Response) {
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
                    purchased,
                    image_location 
                FROM
                    wall_bricks 
                WHERE
                    (x, y) IN (${conditions})
            `;

            const bricks = await db.any(query, values);

            if (bricks.length !== coordinates.length) {
                return res.status(400).json({ error: 'One or more bricks do not exist.' });
            }

            const nonOwnedBricks = bricks.filter(brick => !brick.purchased);
            if (nonOwnedBricks.length > 0) {
                return res.status(400).json({ error: 'One or more bricks are not owned by the user.', nonOwnedBricks });
            }

            const bricksWithoutImage = bricks.filter(brick => !brick.image_location);
            if (bricksWithoutImage.length > 0) {
                return res.status(400).json({ error: 'One or more bricks do not have an image defined.', bricksWithoutImage });
            }

            // Verify the address is holding the NFTs associated with these bricks
            const assetIds = bricks.map(brick => brick.assetId);
            const digitalItems = await this.getDigitalStandardItems(userPublicKey);
            const ownedAssetIds = digitalItems.map(item => item.assetId);

            const missingAssets = assetIds.filter(assetId => !ownedAssetIds.includes(assetId));

            if (missingAssets.length > 0) {
                return res.status(400).json({ error: 'Address does not hold the required NFTs for these bricks.', missingAssets });
            }

            // Create a single transaction for all brick modifications
            const transaction = new Transaction();
            const recentBlockhash = (await this.connection.getLatestBlockhash('finalized')).blockhash;
            const totalSolPayment = PRICE_PER_BRICK_EDIT * bricks.length;

            transaction.add(this.setComputeUnitLimitInstruction());
            transaction.add(this.setComputeUnitPriceInstruction());
            transaction.add(this.transferSOLInstruction(userPublicKey, new PublicKey(FUNDS_DESTINATION), totalSolPayment));
            transaction.add(this.jitoTipInstruction(userPublicKey, JITO_FEE));

            transaction.feePayer = userPublicKey;
            transaction.recentBlockhash = recentBlockhash;

            const serialized = transaction.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            });

            const serializedTransaction = serialized.toString('base64');

            res.status(200).json({ transactions: [serializedTransaction] });
        } catch (error) {
            logger.error('Error modifying bricks:', error);
            res.status(500).json({ error: 'Internal server error.' });
        }
    }

    /* This function will take the coordinate to purchase,
     * check they haven't been purchased already,
     * then create transaction(s) transferring the NFT to the
     * user, transferring SOL from the user to us, along
     * with priority fee and jito fee. We then return the
     * partially signed transaction to the frontend */
    public async purchaseBrickSquares(db: DB, req: Request, res: Response) {
        const { coordinates, solAddress } = req.body;

        try {
            let userPublicKey: PublicKey;

            try {
                userPublicKey = new PublicKey(solAddress);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid SOL address provided.' });
            }

            const selectedBricks: Coordinate[] = coordinates;

            const conditions = selectedBricks.map((_, index) =>
                `($${index * 2 + 1}, $${index * 2 + 2})`
            ).join(', ');

            const values = selectedBricks.flatMap(coord => [coord.x, coord.y]);

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
                return res.status(400).json({ error: 'One or more bricks do not exist.' });
            }

            const transactions = [];
            const recentBlockhash = (await this.connection.getLatestBlockhash('finalized')).blockhash;

            const createTransaction = async (brick: Brick) => {
                const transaction = new Transaction();
                const assetId = brick.assetId;

                transaction.add(this.setComputeUnitLimitInstruction());
                transaction.add(this.setComputeUnitPriceInstruction());
                transaction.add(this.transferSOLInstruction(userPublicKey, new PublicKey(FUNDS_DESTINATION), PRICE_PER_BRICK));
                transaction.add(this.transferSOLInstruction(this.keypair.publicKey, new PublicKey(FUNDS_DESTINATION), 1));

                const { transferInstruction, owner } = await this.transferNFTInstruction(assetId, this.keypair, userPublicKey);
                if (!transferInstruction) {
                    if (owner !== userPublicKey.toBase58()) {
                        throw new Error('One or more bricks are already purchased by another user.');
                    }

                    // Skip this transaction as the user already owns the brick
                    return null;
                }

                transaction.add(transferInstruction);
                transaction.add(this.jitoTipInstruction(userPublicKey, JITO_FEE));

                transaction.feePayer = userPublicKey;
                transaction.recentBlockhash = recentBlockhash;

                transaction.sign(this.keypair);

                const serialized = transaction.serialize({
                    requireAllSignatures: false,
                    verifySignatures: false,
                });

                return serialized.toString('base64');
            };

            const chunkSize = 100;
            for (let i = 0; i < bricks.length; i += chunkSize) {
                const chunk = bricks.slice(i, i + chunkSize);

                try {
                    const chunkTransactions = await Promise.all(chunk.map(createTransaction));
                    // Filter out any null transactions (bricks user already owns)
                    transactions.push(...chunkTransactions.filter(tx => tx !== null));
                } catch (err: any) {
                    res.status(400).json({
                        error: err.toString(),
                    });

                    return;
                }
            }

            res.status(200).json({ transactions });
        } catch (error) {
            logger.error('Error purchasing bricks:', error);
            res.status(500).json({ error: 'Internal server error.' });
        }
    }

    public async modifyDefinedPurchasedBricks(db: DB, req: Request, res: Response) {
        const { images, solAddress, signature } = req.body;

        try {
            let userPublicKey: PublicKey;

            try {
                userPublicKey = new PublicKey(solAddress);
            } catch (e) {
                return res.status(400).json({ error: 'Invalid SOL address provided.' });
            }

            // Step 1: Verify that the bricks exist in the DB and currently have an image defined
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
                return res.status(400).json({ error: 'One or more bricks do not exist.' });
            }

            const undefinedImageBricks = bricks.filter(brick => !brick.image_location);
            if (undefinedImageBricks.length > 0) {
                return res.status(400).json({ error: 'One or more bricks do not have an image defined.', undefinedImageBricks });
            }

            // Verify the address is holding the NFTs associated with these bricks
            const assetIds = bricks.map(brick => brick.assetId);
            const digitalItems = await this.getDigitalStandardItems(userPublicKey);
            const ownedAssetIds = digitalItems.map(item => item.assetId);

            const missingAssets = assetIds.filter(assetId => !ownedAssetIds.includes(assetId));

            if (missingAssets.length > 0) {
                return res.status(400).json({ error: 'Address does not hold the required NFTs for these bricks.', missingAssets });
            }

            // Check that the transaction has not been used before in the edit_bricks table
            const existingTransaction = await db.oneOrNone(
                `SELECT 1 FROM edit_bricks WHERE transaction_hash = $1`, [signature]
            );

            if (existingTransaction) {
                return res.status(400).json({ error: 'Transaction has already been used.' });
            }

            // Step 2: Fetch the transaction with retries
            const fetchTransaction = async (retries: number): Promise<TransactionResponse | null> => {
                for (let i = 0; i < retries; i++) {
                    const transaction = await this.connection.getTransaction(signature);
                    if (transaction) {
                        return transaction;
                    }
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
                return null;
            };

            const transaction = await fetchTransaction(15);

            if (!transaction) {
                return res.status(400).json({ error: 'Transaction not found.' });
            }

            // Step 3: Validate the transaction is sending the correct amount of SOL to FUNDS_DESTINATION
            const totalSolPayment = BigInt(PRICE_PER_BRICK_EDIT * images.length);
            const fundsDestinationPublicKey = new PublicKey(FUNDS_DESTINATION);
            let isValidTransaction = false;

            const txData = transaction.transaction.message;

            for (const instruction of txData.compiledInstructions) {
                let decompiledInstruction;

                try {
                    decompiledInstruction = decompileInstruction(instruction, txData);
                } catch (err) {
                    logger.info(`Failed to decompile instruction: ${JSON.stringify(instruction)} - ${err}`);
                    continue;
                }

                if (decompiledInstruction.programId.equals(SystemProgram.programId)) {
                    try {
                        const parsedInstruction = SystemInstruction.decodeTransfer(decompiledInstruction);
                        if (parsedInstruction.toPubkey.equals(fundsDestinationPublicKey) &&
                            parsedInstruction.fromPubkey.equals(userPublicKey) &&
                            parsedInstruction.lamports === totalSolPayment) {
                            isValidTransaction = true;
                            break;
                        }
                    } catch (err) {
                        logger.info(`Failed to decode transfer instruction: ${err}`);
                    }
                }
            }

            if (!isValidTransaction) {
                return res.status(400).json({ error: 'Invalid transaction: incorrect SOL payment.' });
            }

            // Verify the transaction is signed by the user's SOL address
            const transactionSigners = transaction.transaction.signatures;

            const signer = transaction.transaction.message.staticAccountKeys[0].toString();

            if (signer !== solAddress) {
                return res.status(400).json({ error: 'Transaction not signed by the provided SOL address.' });
            }

            // Step 4: Store the image data on disk and update the database with the image location
            const updateQueries = await Promise.all(images.map(async (image: BrickImage) => {
                const imageName = `${uuidv4()}.png`;
                const imagePath = `${__dirname}../images/${imageName}`;

                // Save the image to disk
                const base64Data = image.image.replace(/^data:image\/png;base64,/, "");
                await fs.writeFile(imagePath, base64Data, 'base64');

                // Update the database with the image location
                return db.none(
                    `UPDATE wall_bricks
                    SET
                        image_location = $1
                    WHERE
                        x = $2
                        AND y = $3`,
                    [imagePath, image.x, image.y]
                );
            }));

            await Promise.all(updateQueries);

            // Store the transaction signature in the edit_bricks table
            await db.none(
                `INSERT INTO edit_bricks (username, transaction_hash) VALUES ($1, $2)`,
                [solAddress, signature]
            );

            this.cachedImage = undefined;
            this.updateWallImage();

            return res.status(200).json({ success: true });
        } catch (error) {
            logger.error('Error modifying defined purchased bricks:', error);
            return res.status(500).json({ error: 'Internal server error.' });
        }
    }

    /* This function will take an array of images, with an x, y, and image key,
     * a sol address, and a signed message "`I am signing this message to confirm that ${publicKey.toString()} can upload images to the million pixel wall`;",
     * this function will verify the signature, verify the bricks exist in the DB and currently all have no image defined,
     * verify the address is holding the NFTs associated with these bricks, using the getDigitalStandardItems API,
     * then store the image data the user uploaded. */
    public async modifyUndefinedPurchasedBricks(db: DB, req: Request, res: Response) {
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

            // Step 2: Verify that the bricks exist in the DB and currently have no image defined
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
                return res.status(400).json({ error: 'One or more bricks do not exist.' });
            }

            const definedImageBricks = bricks.filter(brick => brick.image_location);
            if (definedImageBricks.length > 0) {
                return res.status(400).json({ error: 'One or more bricks already have an image defined.', definedImageBricks });
            }

            // Step 3: Verify the address is holding the NFTs associated with these bricks
            const assetIds = bricks.map(brick => brick.assetId);
            const digitalItems = await this.getDigitalStandardItems(userPublicKey);
            const ownedAssetIds = digitalItems.map(item => item.assetId);

            const missingAssets = assetIds.filter(assetId => !ownedAssetIds.includes(assetId));

            if (missingAssets.length > 0) {
                return res.status(400).json({ error: 'Address does not hold the required NFTs for these bricks.', missingAssets });
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
            this.updateWallImage();

            return res.status(200).json({ success: true });
        } catch (error) {
            logger.error('Error modifying undefined purchased bricks:', error);
            return res.status(500).json({ error: 'Internal server error.' });
        }
    }

    public async getUserBricks(db: DB, req: Request, res: Response) {
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
                    image_location IS NOT NULL AS "hasImage"
                FROM
                    wall_bricks
                WHERE
                    assetId IN ($1:csv)
            `;

            const userBricks = await db.any(query, [assetIds]);

            // Create a map of digital items keyed by assetId
            const digitalItemsMap = new Map(digitalItems.map(item => [item.assetId, item]));

            // Merge brick data with corresponding digital item properties
            const bricksWithDigitalItems = userBricks.map(brick => {
                const digitalItem = digitalItemsMap.get(brick.assetId);

                return {
                    ...brick,
                    ...digitalItem,
                    name: `${brick.x},${brick.y}`,
                };
            });

            return res.status(200).json({
                success: true,
                bricks: bricksWithDigitalItems,
            });
        } catch (error) {
            logger.error('Error fetching user bricks:', error);
            return res.status(500).json({ error: 'Internal server error.' });
        }
    }

    public async getWallInfo(db: DB, req: Request, res: Response) {
        try {
            if (!this.cachedImage || !this.cachedBricks) {
                await this.updateWallImage();
            }

            return res.status(200).json({
                image: this.cachedImage,
                bricks: this.cachedBricks,
                pricePerBrick: PRICE_PER_BRICK,
                pricePerBrickEdit: PRICE_PER_BRICK_EDIT,
            });
        } catch (error) {
            logger.error('Error getting wall info:', error);
            return res.status(500).json({ error: 'Internal server error.' });
        }
    }

    private async preloadImage(src: string): Promise<Image> {
        if (this.cachedImages[src]) {
            return this.cachedImages[src];
        }
        const img = await Image.fromURL(src);
        this.cachedImages[src] = img;
        return img;
    }

    public async updateWallImage() {
        logger.info(`Updating wall image...`);

        try {
            // Query the database to get all bricks/blocks with their purchase and image info
            const query = `
                SELECT x, y, image_location, purchased
                FROM wall_bricks
            `;
            const bricks = await this.db.any(query);

            const multiplier = 10;

            // Create a Fabric.js canvas
            const canvas = new StaticCanvas(undefined, {
                width: CANVAS_WIDTH * multiplier,
                height: CANVAS_HEIGHT * multiplier,
            });

            const defaultImage = await this.preloadImage(`file://${__dirname}../assets/wall.jpg`);

            // Add each brick with an image to the canvas
            await Promise.all(bricks.map(async (brick) => {
                if (!brick.image_location) {
                    return;
                }

                if (brick.purchased) {
                    let image: Image;

                    if (brick.image_location) {
                        image = await this.preloadImage(`file://${brick.image_location}`);
                    } else {
                        image = defaultImage;
                    }

                    // Clone the image to avoid the canvas ownership issue
                    const clonedImage = await image.clone();

                    // Upscale
                    clonedImage.scaleToWidth(BRICK_WIDTH * multiplier);
                    clonedImage.scaleToHeight(BRICK_HEIGHT * multiplier);

                    clonedImage.set({
                        left: brick.x * BRICK_WIDTH * multiplier,
                        top: brick.y * BRICK_HEIGHT * multiplier,
                        selectable: false,
                        objectCaching: true,
                    });

                    canvas.add(clonedImage);
                }
            }));

            // Render the canvas to a data URL
            const dataURL = canvas.toDataURL({
                format: 'png',
                quality: 1.0,
                multiplier: 1,
            });

            const imageData = dataURL.replace(/^data:image\/png;base64,/, '');
            const imagePath = `${__dirname}/../images/canvas.png`;

            await fs.writeFile(imagePath, Buffer.from(imageData, 'base64'));

            // Cache the image and bricks info
            this.cachedImage = dataURL;
            this.cachedBricks = bricks.map(brick => ({
                x: brick.x,
                y: brick.y,
                purchased: brick.purchased,
                name: `${brick.x},${brick.y}`,
            }));
        } catch (error) {
            console.error('Error updating wall image:', error);
            throw new Error('Error updating wall image.');
        }

        logger.info(`Wall image update complete...`);
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
        this.httpServer.use(express.json({ limit: '100MB' }));

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

        this.updatePurchasedbricks();
        this.updateWallImage();
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

        if (rpcAsset.ownership.owner === newOwner.toBase58()) {
            // If the new owner already owns the asset, return null to indicate no transfer is needed
            return { transferInstruction: null, owner: rpcAsset.ownership.owner };
        }

        const leafNonce = rpcAsset.compression.leaf_id;
        const treeAuthority = await getBubblegumAuthorityPDA(merkleTree);
        const leafDelegate = rpcAsset.ownership.delegate
            ? new PublicKey(rpcAsset.ownership.delegate)
            : new PublicKey(rpcAsset.ownership.owner);

        const transferInstruction = createTransferInstruction(
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

        return { transferInstruction, owner: rpcAsset.ownership.owner };
    }

    private async getDigitalStandardItems(address: PublicKey): Promise<CompressedNFT[]> {
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
                    logger.error(`Failed to fetch compressed NFTs: ${response.status}`);
                    break;
                }

                const rawData = await response.json();

                if (rawData.error) {
                    logger.error(`Error fetching compressed NFTs: ${rawData.error.message}`);
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
            logger.error(`Error fetching compressed NFTs: ${err}`);
        }
    
        return compressedNFTs.map((c) => {
            const metadata = c.content?.metadata;

            const image = c.content?.files.length
                ? c.content.files[0].uri
                : undefined;

            return {
                assetId: c.id,
                image,
            }
        });
    }

    private async updatePurchasedbricks() {
        while (true) {
            try {
                // Fetch all current assets in the system wallet
                const currentAssets = await this.getDigitalStandardItems(this.keypair.publicKey);
                const currentAssetIdsSet = new Set(currentAssets.map(asset => asset.assetId));

                // Fetch all bricks from the database that are not marked as purchased
                const bricks = await this.db.any(`SELECT * FROM wall_bricks WHERE purchased = FALSE`);

                // Find bricks whose assetIds are not in the currentAssetIdsSet
                const purchasedBricks = bricks.filter(brick => !currentAssetIdsSet.has(brick.assetid));

                if (purchasedBricks.length > 0 && currentAssets.length > 0) {
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
                logger.error(`Error updating purchased bricks: ${err}`);
            }

            // Sleep for 5 minutes
            await sleep(5 * 60 * 1000);
        }
    }
}
