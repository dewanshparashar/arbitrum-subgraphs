import {
  Address,
  BigInt,
  Bytes,
  crypto,
  ethereum,
} from "@graphprotocol/graph-ts";
import {
  MessageReceived as MessageReceivedEvent,
  MessageSent as MessageSentEvent,
} from "../generated/USDCMessageTransmitter/USDCMessageTransmitter";
import { MessageReceived, MessageSent } from "../generated/schema";
import { log } from "matchstick-as";

function leftPadBytes(data: Bytes, length: number): Bytes {
  const completeData = new Bytes(length as i32);
  const zeroBytesToFillPrefix = completeData.length - data.length;
  for (let i = 0; i < completeData.length; i++) {
    if (i < zeroBytesToFillPrefix) {
      completeData[i] = 0;
    } else {
      completeData[i] = data[i - zeroBytesToFillPrefix];
    }
  }
  return completeData;
}

function bigIntFromBigEndianBytes(data: Uint8Array): BigInt {
  // BigInt.fromUnsignedBytes expects little-endian bytes
  return BigInt.fromUnsignedBytes(Bytes.fromUint8Array(data.slice(0).reverse()));
}

function getIdFromMessage(sourceDomain: BigInt, noncePadded: Bytes): Bytes {
  return Bytes.fromHexString(
    `0${sourceDomain.toString()}${noncePadded.toHexString()}`
  );
}

function getAddressFromBytes32(bytes: Bytes): Bytes {
  assert(
    bytes.length === 32,
    `getAddressFromBytes32: Address bytes length is incorrect (${bytes.length})`
  );
  const slicedBytes = bytes.slice(12);
  return Address.fromUint8Array(slicedBytes);
}

function decodeMessageBodyData(messageBody: Bytes): Array<Bytes> | null {
  // Remove the first 8 characters
  const messageBodyData = ethereum.decode(
    // (usdcContract, recipient, amount, sender)
    "(bytes32,bytes32,uint64,bytes32)",
    messageBody
  );

  if (!messageBodyData) {
    return null;
  }
  const decodedMessageBodyDataTuple = messageBodyData.toTuple();
  const recipient = decodedMessageBodyDataTuple[1].toBytes();
  const amount = decodedMessageBodyDataTuple[2].toBigInt();
  const sender = decodedMessageBodyDataTuple[3].toBytes();

  return [recipient, Bytes.fromByteArray(Bytes.fromBigInt(amount)), sender];
}

export enum ChainDomain {
  Mainnet = 0,
  Arbitrum = 3,
}

function handleMessageReceived(
  event: MessageReceivedEvent,
  expectedSourceDomain: ChainDomain
): void {
  // Only index messages from expected source domain
  if (
    event.params.sourceDomain.notEqual(BigInt.fromI32(expectedSourceDomain))
  ) {
    log.warning(
      "[handleMessageReceived]: sourceDomain {} doesn't correspond to the expected source domain {}",
      [event.params.sourceDomain.toString(), expectedSourceDomain.toString()]
    );
    return;
  }

  const nonce = event.params.nonce;
  const sourceDomain = event.params.sourceDomain;

  const noncePadded = leftPadBytes(
    Bytes.fromHexString("0x".concat(nonce.toHex().slice(2).padStart(8, "0"))),
    32
  );
  const id = getIdFromMessage(sourceDomain, noncePadded);

  let entity = new MessageReceived(id);
  const messageBodyWithoutSignature = Bytes.fromUint8Array(
    event.params.messageBody.slice(4, event.params.messageBody.length)
  );
  const decodedMessageBodyData = decodeMessageBodyData(
    messageBodyWithoutSignature
  );
  if (!decodedMessageBodyData) {
    log.error("messageBodyData doesn't exist", []);
    return;
  }

  const recipient = decodedMessageBodyData[0];
  const sender = decodedMessageBodyData[2];

  entity.caller = event.params.caller;
  entity.sourceDomain = event.params.sourceDomain;
  entity.nonce = event.params.nonce;
  entity.sender = getAddressFromBytes32(sender);
  entity.recipient = getAddressFromBytes32(recipient);
  entity.messageBody = event.params.messageBody;

  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;

  entity.save();
}

function handleMessageSent(
  event: MessageSentEvent,
  expectedDestinationDomain: ChainDomain
): void {
  // message is encoded with encodePacked, fields sit at fixed byte offsets:
  // version [0:4], sourceDomain [4:8], destinationDomain [8:12], nonce [12:20],
  // sender [20:52], recipient [52:84], destinationCaller [84:116], messageBody [116:]
  // see https://developers.circle.com/stablecoin/docs/cctp-technical-reference#message
  // Read with byte slices, not ethereum.decode: https://github.com/graphprotocol/graph-node/issues/6683
  const message = event.params.message;
  if (message.length < 248) {
    log.error("[handleMessageSent]: message is too short ({} bytes)", [
      message.length.toString(),
    ]);
    return;
  }

  const sourceDomain = bigIntFromBigEndianBytes(message.slice(4, 8));
  const destinationDomain = bigIntFromBigEndianBytes(message.slice(8, 12));
  const nonce = bigIntFromBigEndianBytes(message.slice(12, 20));
  const noncePadded = leftPadBytes(
    Bytes.fromUint8Array(message.slice(12, 20)),
    32
  );
  // skip the 4-byte messageBody version, keep the 4 32-byte words
  const messageBody = Bytes.fromUint8Array(message.slice(120, 248));

  if (destinationDomain.notEqual(BigInt.fromI32(expectedDestinationDomain))) {
    log.warning(
      "[handleMessageSent]: destinationDomain {} doesn't correspond to the expected destination domain {}",
      [destinationDomain.toString(), expectedDestinationDomain.toString()]
    );
    return;
  }

  const decodedMessageBodyData = decodeMessageBodyData(messageBody);
  if (!decodedMessageBodyData) {
    log.error("messageBodyData doesn't exist", []);
    return;
  }

  const recipient = decodedMessageBodyData[0];
  const amount = BigInt.fromUnsignedBytes(decodedMessageBodyData[1]);
  const sender = decodedMessageBodyData[2];

  const id = getIdFromMessage(sourceDomain, noncePadded);
  const entityFromStore = MessageSent.load(id);

  // Multiple MessageSent might have the same id when replaced with `replaceMessage`
  // We're only interested in the most recent one
  // Events might not arrive in order, we need to compare timestamp to get the most recent one
  if (entityFromStore) {
    // If the new MessageSent is more recent, override the one in store
    // If the MessageEvent in the store is the most recent, skip
    if (entityFromStore.blockTimestamp.gt(event.block.timestamp)) {
      return;
    }
  }
  const entity = new MessageSent(id);
  entity.message = event.params.message;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.sender = getAddressFromBytes32(sender);
  entity.recipient = getAddressFromBytes32(recipient);
  entity.attestationHash = Bytes.fromByteArray(
    crypto.keccak256(event.params.message)
  );
  entity.sourceDomain = sourceDomain;
  entity.nonce = nonce;
  entity.amount = amount;
  entity.save();
}

export function handleMessageReceivedL1(event: MessageReceivedEvent): void {
  handleMessageReceived(event, ChainDomain.Arbitrum);
}

export function handleMessageSentL1(event: MessageSentEvent): void {
  handleMessageSent(event, ChainDomain.Arbitrum);
}

export function handleMessageReceivedL2(event: MessageReceivedEvent): void {
  handleMessageReceived(event, ChainDomain.Mainnet);
}

export function handleMessageSentL2(event: MessageSentEvent): void {
  handleMessageSent(event, ChainDomain.Mainnet);
}
