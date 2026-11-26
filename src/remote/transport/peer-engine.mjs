function nativeIceServers(iceServers) {
  return iceServers.flatMap(({ urls, username, credential }) => urls.map((uri) => {
    if (uri.startsWith('stun:')) return uri;
    const url = new URL(uri.replace(/^turns?:/i, 'http://'));
    const tls = uri.startsWith('turns:');
    return {
      hostname: url.hostname, port: Number(url.port || (tls ? 5349 : 3478)),
      username, password: credential,
      relayType: tls ? 'TurnTls' : url.searchParams.get('transport') === 'tcp' ? 'TurnTcp' : 'TurnUdp',
    };
  }));
}

export async function loadPeerFactory(requested = 'auto', log = () => {}) {
  if (requested !== 'libdatachannel') {
    try {
      const { default: wrtc } = await import('@roamhq/wrtc');
      const { RTCPeerConnection } = wrtc;
      if (typeof RTCPeerConnection !== 'function') throw new Error('RTCPeerConnection is unavailable');
      return {
        engine: 'libwebrtc',
        createPeer: (_name, { iceServers, iceTransportPolicy }) =>
          new BrowserPeer(new RTCPeerConnection({ iceServers, iceTransportPolicy })),
      };
    } catch (error) {
      if (requested === 'libwebrtc') {
        throw new Error(`Could not load libwebrtc. Run npm ci with optional dependencies on a supported platform: ${error.message}`);
      }
      log(`libwebrtc is unavailable. Trying libdatachannel (${error.message}).`);
    }
  }

  try {
    const { PeerConnection } = await import('node-datachannel');
    return {
      engine: 'libdatachannel',
      createPeer: (name, config) => new PeerConnection(name, { ...config, iceServers: nativeIceServers(config.iceServers) }),
    };
  } catch (error) {
    throw new Error(`Could not load libdatachannel. Check the installed Node.js dependencies: ${error.message}`);
  }
}

class BrowserPeer {
  constructor(pc) {
    this.pc = pc;
    this.pendingLocalCandidates = [];
    this.answerSent = false;
  }

  onLocalDescription(handler) {
    this.localDescriptionHandler = handler;
  }

  onLocalCandidate(handler) {
    this.localCandidateHandler = handler;
    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate?.candidate || typeof candidate.sdpMid !== 'string') return;
      if (this.answerSent) handler(candidate.candidate, candidate.sdpMid);
      else this.pendingLocalCandidates.push(candidate);
    };
  }

  onStateChange(handler) {
    this.pc.onconnectionstatechange = () => handler(this.pc.connectionState);
  }

  onDataChannel(handler) {
    this.pc.ondatachannel = ({ channel }) => handler(new BrowserChannel(channel));
  }

  async setRemoteDescription(sdp, type) {
    this.remoteDescriptionReady = this.pc.setRemoteDescription({ sdp, type });
    await this.remoteDescriptionReady;
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    const description = this.pc.localDescription;
    this.localDescriptionHandler(description.sdp, description.type);
    this.answerSent = true;
    for (const candidate of this.pendingLocalCandidates) {
      this.localCandidateHandler(candidate.candidate, candidate.sdpMid);
    }
    this.pendingLocalCandidates.length = 0;
  }

  async addRemoteCandidate(candidate, sdpMid) {
    await this.remoteDescriptionReady;
    await this.pc.addIceCandidate({ candidate, sdpMid });
  }

  close() {
    this.pc.close();
  }

  async transportStats() {
    const reports = await this.pc.getStats();
    const transport = [...reports.values()].find((report) => report.type === 'transport' && report.selectedCandidatePairId);
    const pair = transport ? reports.get(transport.selectedCandidatePairId) : undefined;
    const local = pair && reports.get(pair.localCandidateId);
    const remote = pair && reports.get(pair.remoteCandidateId);
    if (!local || !remote) return null;
    const candidate = (report) => `${report.candidateType}/${report.protocol.toUpperCase()}`;
    const data = [...reports.values()].find((report) => report.type === 'data-channel');
    return {
      route: `${candidate(local)} → ${candidate(remote)}`,
      rtt: pair.currentRoundTripTime === undefined ? -1 : Math.round(pair.currentRoundTripTime * 1000),
      bytes: data?.bytesSent,
      rateLabel: 'DataChannel output',
    };
  }
}

// Keep browser-style WebRTC behind the same channel interface used by DSP and PeerJS.
class BrowserChannel {
  constructor(channel) {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
  }

  getLabel() { return this.channel.label; }
  isOpen() { return this.channel.readyState === 'open'; }
  bufferedAmount() { return this.channel.bufferedAmount; }
  close() { this.channel.close(); }
  onOpen(handler) { this.channel.onopen = handler; }
  onClosed(handler) { this.channel.onclose = handler; }
  onError(handler) { this.channel.onerror = handler; }

  onMessage(handler) {
    this.channel.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) handler(Buffer.from(data));
    };
  }

  sendMessageBinary(buffer) {
    // WebRTC's send() does not classify a successful write as immediate or queued.
    this.channel.send(buffer);
  }
}
