# BrowSDR Runner

Share an RTL-SDR or HackRF from a Linux machine. The runner captures samples, registers a share code, and streams a waterfall and either audio or IQ to a BrowSDR browser client over WebRTC.

## Quick start

Install Node.js 24 or later and the capture tool for your device. For RTL-SDR on Debian or Ubuntu, run these commands from the runner checkout:

```bash
sudo apt install rtl-sdr
git submodule update --init --recursive
npm ci --include=optional
npm start
```

The runner starts `rtl_tcp` on loopback. For HackRF, install `hackrf` from package manager and run `npm start -- --device hackrf`. Use `--serial` to select a device if you have more than one. For RTL-SDR it accepts a serial number or device index.

```bash
npm start -- --serial 00000001 --frequency 99900000 --sample-rate 2048000
npm start -- --help
```

When capture and signaling are ready, the runner prints a share code and link. Open the link, unmute the VFO you want to hear, and select a mode under **Source → Decode on**.

## Listening and tuning

| Decode on | What the runner sends |
| --- | --- |
| **Host (audio)** | 48 kHz PCM mixed from active VFOs. Supports WFM, NFM, AM, USB, LSB, DSB, CW, and RAW. Volume, solo, mute, and squelch apply. |
| **This device (IQ)** | An IQ slice for each active VFO. The browser demodulates the signal and can run digital decoders such as HD Radio, DSD, and RDS. |

A VFO pauses below 50 Hz bandwidth. In host mode, narrow VFOs use a lower IF sample rate and WFM below 106 kHz plays in mono. In IQ mode, the slice leaves room for the browser's channel filter.

Clients can change the shared center frequency, sample rate, and gains. Pass `--keep-locks` to lock those controls. For RTL-SDR, the runner applies the most recent requests at 200 ms intervals while keeping the device open. It briefly discards samples after a retune or sample rate change. Gain steps depend on the tuner, and the UI shows the settings applied by the runner because `rtl_tcp` has no command acknowledgement. HackRF reopens capture after a shared RF setting changes.

## Choose a BrowSDR site

The default is the official [browsdr.jlynx.net](https://browsdr.jlynx.net/). Use `--url` to select one site per runner. If a self-hosted frontend and its backend use different paths, also pass `--backend-url`.

```bash
npm start -- --url https://sdr.internal/
npm start -- --url https://sdr.internal/sdr/ --backend-url https://sdr.internal/
```

The runner loads ICE servers from `api/turn` under the backend base URL. The self-hosted container uses `signal/peerjs` under that same base. The official site uses PeerJS Cloud for signaling.

For an internal HTTPS site, install the CA in the host's trust store or set `NODE_EXTRA_CA_CERTS` to the CA certificate path. The `npm start` command enables Node's system CA support.

If the backend requires proxy authentication, set `BROWSDR_AUTH_ORIGIN` to its HTTPS origin and provide the complete `BROWSDR_AUTHORIZATION` or `BROWSDR_COOKIE` header value. The runner scopes these headers to the authorized backend and its signaling endpoint on that origin.

## Run as a service

The runner retries signaling registration with a delay of 1 to 30 seconds and restarts capture if the SDR tool exits. Keep the state directory to reuse the same share code across restarts. It defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/browsdr-runner/`. Use a separate `--state-dir` for each runner that shares an SDR of the same type on the same site.

Share codes use 20 lowercase hexadecimal characters. After upgrading from a version with shorter codes, use the newly printed link. Anyone with a valid share code and access to the site can connect.

Save this example as `/etc/systemd/system/browsdr-runner.service` and adjust the service user, Node binary path, and checkout path. Add `--url` to `ExecStart` to select a self-hosted site.

```ini
[Unit]
Description=BrowSDR native SDR host
Wants=network-online.target
After=network-online.target

[Service]
User=sdr
WorkingDirectory=/opt/browsdr-runner
StateDirectory=browsdr-runner
ExecStart=/usr/bin/node --use-system-ca /opt/browsdr-runner/runner.mjs --state-dir /var/lib/browsdr-runner
Restart=on-failure
RestartSec=5
EnvironmentFile=-/etc/browsdr-runner.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now browsdr-runner
journalctl -u browsdr-runner -f
```

### Discord startup notification

Set `BROWSDR_DISCORD_WEBHOOK_URL` to your Discord webhook URL. The runner posts the share link once per process when capture and signaling are ready. For systemd, put the value in `/etc/browsdr-runner.env`, set file permissions to `0600`, and restart the service.

```ini
BROWSDR_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
```

## Troubleshooting

### Audio cuts out on a high latency connection

Check the startup log for `WebRTC engine: libwebrtc.` The default, `--webrtc auto`, prefers libwebrtc and falls back to libdatachannel if the optional binary cannot load. To require libwebrtc and log transport statistics, run:

```bash
npm ci --include=optional
npm start -- --webrtc libwebrtc --stats
```

Keep your usual site, sample rate, and state directory options. On one TURN relay path at about 455 ms RTT, libwebrtc restored stable **Host (audio)** playback after startup, with about 1.55 Mbps of mono PCM output and zero runner PCM drops during the measured interval. That run used `--iq-queue-ms 250` for **This device (IQ)**. You can force `--webrtc libdatachannel` for comparison. [libwebrtc binding](https://github.com/WonderInventions/node-webrtc) · [libdatachannel platform support](https://github.com/murat-dogan/node-datachannel#supported-platforms)

Use `--stats` to distinguish capture stalls from send congestion. It reports every 10 seconds.

| What to check | How to read it |
| --- | --- |
| `capture gap max`, `DSP/send work` | Capture stalls and time spent processing samples. Stock `rtl_tcp` uses 256 KiB USB blocks, which take about 64 ms to fill at 2.048 MSPS. |
| `PCM queue max`, `discarded PCM frames` | A queue near its limit and rising drops indicate that host audio is backing up. `--pcm-queue-ms 200` can absorb brief stalls. A queue that stays full indicates the connection is falling behind. |
| `IQ queue max`, `blocked blocks`, `discarded IQ values` | Congestion when sending IQ. `--iq-queue-ms` controls its queue independently of PCM. |
| `Audio transport` | A `relay` candidate means the audio uses TURN. Compare the selected route, RTT, and the browser's playback gaps. Both the SCTP input and DataChannel output counters report the sender's view. |

Mono PCM needs about 1.54 Mbps per listener, and stereo needs about 3.07 Mbps, before protocol overhead and the waterfall. Try `--waterfall-fps 5` to reduce display traffic or `--waterfall-fps 0` to isolate audio while troubleshooting.

### RTL-SDR cannot be opened

Check USB permissions for the service user and whether a kernel driver or another SDR program has claimed the device. With the device free, run `rtl_test -t` as the service user. If the device disappears, check `sudo journalctl -k -f` and `lsusb -t`. The runner retries capture when the device returns. [RTL-SDR permissions and driver notes](https://github.com/osmocom/rtl-sdr/blob/master/debian/README.Debian)

## Self-host BrowSDR

The [Docker build](sdr/Dockerfile) serves the BrowSDR web app and PeerServer on port 8080. Run the SDR runner separately on the machine with the device. Use an HTTPS reverse proxy for the app and run coturn separately with the username `browsdr` and the same `TURN_PASSWORD`. Set `TURN_LAN_IP` to the TURN IPv4 address reachable by both runner and browser.

```yaml
services:
  sdr:
    build:
      context: ./sdr
      args:
        VITE_BASE_PATH: /
        VITE_BACKEND_URL: ""
    environment:
      TURN_LAN_IP: ${TURN_LAN_IP}
      TURN_PASSWORD: ${TURN_PASSWORD:?Set TURN_PASSWORD in .env}
```

If your proxy is another Compose service, put it on the same Docker network and point it at `sdr:8080`. For a proxy running on the host, publish `127.0.0.1:8080:8080`.

To serve at `/sdr/`, set `VITE_BASE_PATH: /sdr/`, proxy both `/sdr` and `/sdr/*` with the path intact, and use `--url https://sdr.internal/sdr/`. Leave `VITE_BACKEND_URL` empty to keep the APIs below `/sdr/`. If you set it to `/`, also proxy `/api/turn`, `/api/geo`, and `/signal/*` at the root and pass `--backend-url https://sdr.internal/` to the runner. Rebuild the image after changing either build argument. The container omits the optional `/hf-proxy/` transcription endpoint.

## Development

The runner uses the PeerJS `cmd`, `fft`, and `audio` channels, BrowSDR Remote IQ v1, and the existing PCM format. The submodule and Docker build pin [BrowSDR commit `255ceef`](https://github.com/jLynx/BrowSDR/tree/255ceef490d90733a26baa6c0fde9c2b7d3fb0ef). A Compose build argument named `BROWSDR_REF` overrides the Docker default. When updating that ref, check the [build patch](sdr/patch.mjs), audio, waterfall, and tuning in both decoding modes.

By default the runner loads its WASM bundle from `BrowSDR/wasm/dsp/pkg/`. To use a separate build, point `--dsp-dir` to a directory containing `browsdr_dsp.js`, `browsdr_dsp_bg.wasm`, and `package.json` from that build.

```bash
npm test
BROWSDR_DSP_DIR=/opt/browsdr-dsp/known-good npm test
```

### Code layout

| Path | Responsibility |
| --- | --- |
| `runner.mjs` | Capture and sharing lifecycle |
| `src/cli.mjs` | CLI options and environment settings |
| `src/capture/` | RTL-SDR and HackRF capture and controls |
| `src/dsp/` | WASM, IQ slices, audio, and waterfall |
| `src/remote/` | Share identity and packet formats |
| `src/remote/transport/` | PeerServer signaling and WebRTC |
| `src/integrations/` | External integrations |
| `test/` | Runner tests |
