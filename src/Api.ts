import { PixelWall } from './PixelWall.js';
import { DB } from './Types.js';

export class Api {
    constructor(
        private pixelWall: PixelWall,
        private db: DB,
    ) {
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
}
