import { ImageManipulation } from './ImageManipulation.js';
import { logger } from './Logger.js';

async function main() {
    logger.info(`Initializing`);

    const manipulation = new ImageManipulation();

    try {
        logger.info(`Loading image`);

        const image1 = await manipulation.loadImage('../images/1.png');

        logger.info(`Cropping image`);

        const croppedImage1 = await manipulation.cropImage(image1, 792, 844);

        logger.info(`Rasterizing image`);

        const rasterizedImages = await manipulation.rasterbate(croppedImage1, 4, 3); 

        logger.info(`Saving rasterized images`);

        let i = 1;

        for (const image of rasterizedImages) {
            await manipulation.saveDataURL(`output/cropped-${i.toString().padStart(5, '0')}.png`, image.dataURL);
            i++;
        }

        logger.info(`Converting rasterized images to Image class`);

        const gridImages = await Promise.all(rasterizedImages.map((i) => manipulation.dataURLToImage(i.dataURL)));

        logger.info(`Reassembling image from raster`);

        const reassembledImage = await manipulation.createImageGrid(gridImages, 4, 3);

        logger.info(`Saving reassembled image`);

        await manipulation.saveDataURL(`output/reassembled.png`, reassembledImage);
    } catch (err) {
        console.log(`Caught unexpected error: ${err}`);
    }
}

main();
