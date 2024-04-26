import * as fs from 'fs/promises';
import { Image, StaticCanvas } from 'fabric/node';
import * as url from 'url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

export class ImageManipulation {
    constructor() {
    }

    /* Convert images into larger image grid, returns data URL */
    public async createImageGrid(images: Image[], rows: number, columns: number): Promise<string> {
        if (images.length === 0) {
            throw new Error('No images given');
        }

        if (images.length < rows * columns) {
            throw new Error(`Images provided: ${images.length}. Images required: ${rows * columns}`);
        }

        const uniqueWidths = new Set();
        const uniqueHeights = new Set();

        for (const image of images) {
            uniqueWidths.add(image.width);
            uniqueHeights.add(image.height);
        }

        if (uniqueHeights.size > 1 || uniqueWidths.size > 1) {
            throw new Error(`This function only supports creating grids of images that are all the same size`);
        }

        const canvas = new StaticCanvas();

        const totalWidth = images[0].width * columns;
        const totalHeight = images[0].height * rows;

        canvas.setDimensions({
            width: totalWidth,
            height: totalHeight,
        });

        for (let i = 0; i < rows; i++) {
            for (let j = 0; j < columns; j++) {
                const index = (columns * i) + j;
                const image = images[index];

                const leftOffset = j * image.width;
                const topOffset = i * image.height;

                /* TODO: Is this needed? */
                const imageClone = await this.cloneImage(image);

                imageClone.set({
                    left: leftOffset,
                    top: topOffset,
                });

                canvas.add(imageClone);
            }
        }

        return canvas.toDataURL({
            multiplier: 1,
        });
    }

    /* Clones image by converting to data URL and back to Image */
    public async cloneImage(image: Image): Promise<Image> {
        const dataURL = await this.imageToDataURL(image);
        return this.dataURLToImage(dataURL);
    }

    /* Load image from disk into Image class */
    public async loadImage(filepath: string): Promise<Image> {
        const image = await Image.fromURL(`file://${__dirname}${filepath}`);
        return image;
    }

    /* Save data URL to filepath given */
    public async saveDataURL(filepath: string, dataURL: string): Promise<void> {
        const imageData = dataURL.replace(/^data:image\/png;base64,/, '');
        await fs.writeFile(filepath, Buffer.from(imageData, 'base64'));
    }

    /* Convert dataURL to Image class */
    public async dataURLToImage(dataURL: string): Promise<Image> {
        const image = await Image.fromURL(dataURL);
        return image;
    }

    /* Convert Image to data URL */
    public async imageToDataURL(image: Image): Promise<string> {
        return image.toDataURL({
            format: 'png',
            left: 0,
            top: 0,
            width: image.width,
            height: image.height,
        });
    }

    /* Crop image to given width/height */
    public async cropImage(image: Image, width: number, height: number): Promise<Image> {
        const dataURL = image.toDataURL({
            format: 'png',
            left: 0,
            top: 0,
            width,
            height,
        });

        return this.dataURLToImage(dataURL);
    }

    /* Split image into rows * columns images, returns array of data URLs with info */
    public async rasterbate(image: Image, rows: number, columns: number) {
        const width = image.width;
        const height = image.height;

        if (width % columns !== 0) {
            throw new Error(`Image width must be cleanly divisible into ${columns} columns`);
        }

        if (height % rows !== 0) {
            throw new Error(`Image height must be cleanly divisible into ${rows} rows`);
        }

        const columnWidth = width / columns;
        const rowHeight = height / rows;

        const croppedImages = [];

        for (let i = 0; i < rows; i++) {
            for (let j = 0; j < columns; j++) {
                const leftOffset = j * columnWidth;
                const topOffset = i * rowHeight;

                const croppedImage = image.toDataURL({
                    format: 'png',
                    left: leftOffset,
                    top: topOffset,
                    width: columnWidth,
                    height: rowHeight,
                });

                croppedImages.push({
                    left: leftOffset,
                    top: topOffset,
                    width: columnWidth,
                    height: rowHeight,
                    dataURL: croppedImage,
                });
            }
        }
        
        return croppedImages;
    }
}
