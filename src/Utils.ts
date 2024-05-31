import { PROGRAM_ID } from "@metaplex-foundation/mpl-bubblegum";
import tweetnacl from "tweetnacl";
import {
    PublicKey,
    TransactionInstruction,
    SystemProgram,
    SystemInstruction,
    Transaction,
    MessageAccountKeys,
    MessageCompiledInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';

export function pickRandomItem<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
}

export async function getBubblegumAuthorityPDA(merkleRollPubKey: PublicKey) {
    const [bubblegumAuthorityPDAKey] = await PublicKey.findProgramAddress(
        [merkleRollPubKey.toBuffer()],
        PROGRAM_ID,
    );
    return bubblegumAuthorityPDAKey;
}

export function bufferToArray<T extends ArrayLike<number>>(buffer: T): number[] {
    const nums = [];

    for (let i = 0; i < buffer.length; i++) {
        nums.push(buffer[i]);
    }

    return nums;
}

export async function verifySignature(request: { address: string, toSign: Uint8Array, signature: Uint8Array }) {
    const address = new PublicKey(request.address);
    const toSign = request.toSign;

    const signature = Uint8Array.from(request.signature);

    // Verify signature
    if (!tweetnacl.sign.detached.verify(toSign, signature, address.toBytes())) {
        return false;
    }

    const strMessage = new TextDecoder().decode(toSign);
    const pieces = strMessage.split(" ");
    const solWallet = pieces[8]; // Adjust index based on message format

    // Ensure address in message matches address that signed
    if (solWallet !== address.toString()) {
        return false;
    }

    return true;
}

export async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function decompileInstruction(instruction: MessageCompiledInstruction, txData: any): TransactionInstruction {
    const messageAccountKeys = new MessageAccountKeys(txData.staticAccountKeys);

    return new TransactionInstruction({
        data: Buffer.from(instruction.data),
        programId: new PublicKey(messageAccountKeys.get(instruction.programIdIndex)!),
        keys: instruction.accountKeyIndexes.map((accountIndex: any) => {
            return {
                isSigner: txData.isAccountSigner(accountIndex),
                isWritable: txData.isAccountWritable(accountIndex),
                pubkey: messageAccountKeys.get(accountIndex)!,
            };
        }),
    });
}
