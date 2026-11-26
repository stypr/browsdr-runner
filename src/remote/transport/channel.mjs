export function trySendBinary(channel, packet) {
  try {
    // libdatachannel returns false when it queues the packet. libwebrtc returns no value.
    return channel.sendMessageBinary(packet) !== false;
  } catch {
    // A DataChannel can close after the caller checks isOpen().
    return null;
  }
}
