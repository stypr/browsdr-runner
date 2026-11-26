import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanup, PeerConnection } from 'node-datachannel';
import { loadPeerFactory } from '../src/remote/transport/peer-engine.mjs';
import { describeAudioTransport } from '../src/remote/transport/signaling.mjs';
import { iqPacket, pcmPacket } from '../src/remote/protocol.mjs';

test('the libwebrtc answerer exchanges commands, PCM and IQ with a WebRTC client', { timeout: 10000 }, async (t) => {
  let createPeer;
  try {
    ({ createPeer } = await loadPeerFactory('libwebrtc'));
  } catch (error) {
    return t.skip(error.message);
  }

  const config = { iceServers: [], iceTransportPolicy: 'all' };
  assert.equal((await loadPeerFactory()).engine, 'libwebrtc');
  const remote = new PeerConnection('test-client', config);
  const answerer = createPeer('test-runner', config);
  const { promise: failed, reject: rejectNegotiation } = Promise.withResolvers();
  const pending = [];
  let offered = false;
  try {
    answerer.onLocalDescription((sdp, type) => remote.setRemoteDescription(sdp, type));
    answerer.onLocalCandidate((candidate, mid) => remote.addRemoteCandidate(candidate, mid));
    remote.onLocalDescription((sdp, type) => {
      answerer.setRemoteDescription(sdp, type).catch(rejectNegotiation);
      offered = true;
      for (const args of pending) answerer.addRemoteCandidate(...args).catch(rejectNegotiation);
    });
    remote.onLocalCandidate((candidate, mid) => {
      if (offered) answerer.addRemoteCandidate(candidate, mid).catch(rejectNegotiation);
      else pending.push([candidate, mid]);
    });

    const { promise: cmdReceived, resolve: resolveCommand } = Promise.withResolvers();
    const { promise: audioReceived, resolve: resolveAudio } = Promise.withResolvers();
    const pcm = pcmPacket(Float32Array.of(0.5, -0.5), 1);
    const iq = iqPacket({
      index: 0, revision: 1, sequence: 0,
      plan: { centerFreq: 100, sampleRate: 250000, bandwidth: 150000 },
    }, Buffer.from([1, 2]), 1 / 128);
    answerer.onDataChannel((channel) => {
      if (channel.getLabel() === 'cmd') channel.onMessage(resolveCommand);
      if (channel.getLabel() === 'audio') {
        const sendAudio = () => {
          const padded = Buffer.concat([Buffer.from([0xff]), pcm, Buffer.from([0xff])]);
          channel.sendMessageBinary(padded.subarray(1, -1));
          channel.sendMessageBinary(iq);
        };
        channel.onOpen(sendAudio);
        if (channel.isOpen()) sendAudio();
      }
    });
    const command = remote.createDataChannel('cmd');
    const audio = remote.createDataChannel('audio', { unordered: true });
    command.onOpen(() => command.sendMessageBinary(Buffer.from([1, 3, 5])));
    const packets = [];
    audio.onMessage((data) => {
      packets.push(data);
      if (packets.length === 2) resolveAudio(packets);
    });

    const [incoming, outgoing] = await Promise.race([
      Promise.all([cmdReceived, audioReceived]), failed,
    ]);
    assert.deepEqual(incoming, Buffer.from([1, 3, 5]));
    assert(outgoing.some((packet) => packet.equals(pcm)));
    assert(outgoing.some((packet) => packet.equals(iq)));
    const client = { connections: new Map([['audio', { label: 'audio', pc: answerer }]]) };
    assert.match(await describeAudioTransport(client), /UDP.*UDP, RTT .*DataChannel output/);
  } finally {
    answerer.close();
    remote.close();
    cleanup();
  }
});
