# BrowSDR Runner

A Node.js CLI for sharing an SDR continuously from Linux. It starts USB capture through `rtl_tcp` or `hackrf_transfer`, registers with BrowSDR's PeerServer over WSS, and sends a waterfall and either IQ or PCM audio over WebRTC DataChannels. It uses BrowSDR's WASM DSP for per-VFO band extraction, FM demodulation, and FFT processing. Depending on the client's selected mode, demodulation runs on the host or in the receiving browser.

## Getting started

You need Node.js 24 or later, the tools for your SDR, and a BrowSDR deployment. The selected site must serve `/api/turn`. The LAN build uses its PeerServer at `/signal/peerjs`; the official site uses PeerJS Cloud at `0.peerjs.com/peerjs`. If you use the earlier Dockerfile, a build that includes the `fix/remote-audio-buffering` branch lets clients select either decoding mode. Keep a BrowSDR checkout in the runner repository's `BrowSDR/` directory, or use `--dsp-dir` to point to a verified WASM bundle.

On Debian and Ubuntu, `rtl_tcp` is included in the `rtl-sdr` package. The runner starts it itself on the loopback address `127.0.0.1`, so you do not need a separate service or an exposed port.

```bash
sudo apt install rtl-sdr
cd /path/to/browsdr-runner
npm ci
npm start
```

If you have multiple SDRs of the same type, select one with `--serial`. For RTL-SDR, this option accepts a serial number or device index.

```bash
npm start -- --serial 00000001 --frequency 99900000 --sample-rate 2048000
```

To use a HackRF, install `hackrf_transfer` and select the device type:

```bash
npm start -- --device hackrf
```

Once capture and signaling registration are ready, the CLI prints the share code and URL to standard output. Open the link in BrowSDR, unmute the VFO you want to hear, and select a mode under **Source → Decode on**.

Share codes are 20 lowercase hexadecimal characters generated from 80 random bits. When upgrading from a version with shorter codes, the runner replaces its saved share identity on the next start. Old links stop working; use the new URL printed by the CLI or sent through the Discord webhook. Keep the link private, since anyone with the code can connect.

- **Host (audio)** demodulates WFM (including stereo), NFM, AM, USB/LSB/DSB, CW, and RAW on the runner, then mixes audio from multiple VFOs into 48 kHz PCM. Volume, solo, mute, and squelch settings apply.
- **This device (IQ)** sends IQ for demodulation in the receiving browser. Select this mode for digital decoders such as HD Radio, DSD, or RDS.

For narrow VFOs, the host demodulates at a lower IF sample rate. In IQ mode, the transmit filter leaves some headroom, and the client filters to its requested bandwidth. A VFO pauses when its bandwidth is below 50 Hz. Host WFM demodulates in mono below 106 kHz.

By default, clients can change the shared center frequency, sample rate, and exposed gains. RTL-SDR applies these settings while keeping the device open. When clients send repeated requests, the runner applies only the latest value for each setting at 200 ms intervals. A gain change keeps IQ transmission running. After a center frequency or sample rate change, the runner briefly discards samples to reduce mixing of IQ from the old setting. Available gain steps depend on the tuner. Because `rtl_tcp` has no command acknowledgement, the values shown in the UI reflect settings processed by the runner. Changing shared HackRF settings reopens capture. Use `--keep-locks` to lock shared settings.

The default site is `https://browsdr.jlynx.net/`. To use the personal site instead, run `npm start -- --url https://sdr.internal/`. The runner selects the matching signaling server for each site. `npm start` enables Node's system CA support. Install your server's internal CA into the Linux host trust store, or set `NODE_EXTRA_CA_CERTS=/path/to/internal-root.pem` in the runner's environment. If Caddy requires authentication, set `BROWSDR_AUTHORIZATION` or `BROWSDR_COOKIE` to the complete header value. These headers are sent only to `BROWSDR_AUTH_ORIGIN`, which defaults to the LAN site. Set that variable to a different HTTPS origin if needed. Proxy credentials are never sent to PeerJS Cloud.

## Checking latency

The spectrum and waterfall use the same 65,536-point FFT and time averaging as the browser host. The runner selects the maximum of each group of 32 adjacent bins and sends 2,048 display bins. This reduces large jumps in the line caused by brief noise changes.

```bash
npm start -- --stats
```

The runner prints these metrics every 10 seconds:

| Metric | Meaning |
| --- | --- |
| `capture gap max` | Longest interval between IQ deliveries to the runner. This includes USB transfer, the capture tool's block size, and OS scheduling. |
| `DSP/send work` | Time spent on DSP and packet sending over 10 seconds, plus the longest time spent processing one IQ callback. |
| `IQ queue max` | Estimated queue duration, calculated from buffered bytes on the DataChannel and the total send rate of active IQ streams. |
| `blocked blocks`, `discarded IQ values` | Blocks skipped because the send queue was full, and leftover I/Q values that were not turned into packets. |
| `slice runs` | Actual slice extraction runs and subscription processing counts. Slices with the same frequency, width, and rate are computed once per capture block. |
| `PCM packets`, `PCM queue max`, `discarded PCM frames` | Host-mode packets sent, maximum estimated send queue duration, and audio frames skipped because the queue was full. |

Osmocom's default `rtl_tcp` uses 256 KiB USB blocks. Filling one block takes about 41 ms at 3.2 MSPS, 64 ms at 2.048 MSPS, or 524 ms at 250 kSPS. With HackRF, the interval depends on when `hackrf_transfer` produces data. The default IQ send queue target is 80 ms. You can adjust it with an option such as `--iq-queue-ms 60`. A lower target limits the buildup of old samples but skips samples more often during short transmission stalls. The runner also enforces enough capacity for two packets and an upper byte limit. [Osmocom capture block settings](https://github.com/osmocom/rtl-sdr/blob/master/src/rtl_tcp.c) · [librtlsdr default block size](https://github.com/osmocom/rtl-sdr/blob/master/src/librtlsdr.c)

If audio arrives late, compare these metrics with the receiving browser's **Playback buffer** and **Max arrival gaps**. The queue option only affects IQ sending on the host. The browser's playback buffer and any network delay through TURN also add to listening latency.

## Upstream compatibility

The runner uses PeerJS `cmd` / `fft` / `audio` channels, BrowSDR Remote IQ v1, and the existing PCM packet format. It sends host PCM to clients that configure a VFO without requesting IQ. The upstream `main` commit `0135a685`, checked on 2026-11-24, does not have a Remote IQ client. If you need IQ mode, pin BrowSDR to `6c914c571435b514d40ec79a814acd1c79580f7c`, which includes Remote IQ, or to a later commit you have tested. [Remote IQ support commit](https://github.com/jLynx/BrowSDR/tree/6c914c571435b514d40ec79a814acd1c79580f7c) · [Checked main commit](https://github.com/jLynx/BrowSDR/tree/0135a6855bf236525f0a90d1a4bdf726516de038)

By default, the WASM bundle is loaded from `BrowSDR/wasm/dsp/pkg/` in the runner repository. If you pin a separate bundle, point `--dsp-dir` to a directory containing `browsdr_dsp.js`, `browsdr_dsp_bg.wasm`, and `package.json` from the same build.

```bash
npm start -- --dsp-dir /opt/browsdr-dsp/known-good --stats
BROWSDR_DSP_DIR=/opt/browsdr-dsp/known-good npm test
```

`npm test` checks the runner's capture, WASM demodulation, packet formats, and Discord notification. When you replace the client build, use a test share link to check audio, waterfall, and tuning in both decoding modes.

## Code layout

- `runner.mjs` handles CLI options and the capture and sharing service lifecycle.
- `src/capture/` handles device settings and RTL-SDR or HackRF capture.
- `src/dsp/` loads BrowSDR WASM and processes IQ, audio, and spectrum data.
- `src/remote/` handles the saved share identity, PeerServer, WebRTC packets, and Discord notifications.
- `test/` contains the runner tests.

## Running continuously

If signaling disconnects, the runner retries registration after 1 to 30 seconds. Clients can reopen the same link after their WebRTC sessions disconnect. If the SDR is removed or capture exits, the runner also restarts the SDR tool. By default, the share ID and registration token are stored in `${XDG_STATE_HOME:-$HOME/.local/state}/browsdr-runner/`. Use a separate `--state-dir` for another service or SDR when needed.

Here is a systemd example. Adjust `User`, the Node path, and the checkout path for your machine.

```ini
[Unit]
Description=BrowSDR native SDR host
Wants=network-online.target
After=network-online.target

[Service]
User=sdr
WorkingDirectory=/opt/browsdr-runner
StateDirectory=browsdr-runner
ExecStart=/usr/bin/node --use-system-ca /opt/browsdr-runner/runner.mjs --url https://browsdr.jlynx.net/ --state-dir /var/lib/browsdr-runner
Restart=on-failure
RestartSec=5
EnvironmentFile=-/etc/browsdr-runner.env

[Install]
WantedBy=multi-user.target
```

For the personal/internal server, replace the `--url` in `ExecStart` with `https://sdr.internal/`. Run one runner per SDR; the selected site determines where clients can find its share code.

If you save the example as `/etc/systemd/system/browsdr-runner.service`, start it and check the share code with:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now browsdr-runner
journalctl -u browsdr-runner -f
```

### Discord startup notification

Set `BROWSDR_DISCORD_WEBHOOK_URL` to a webhook URL copied from your Discord channel. Once SDR capture and signaling registration are ready, the runner posts the `?connect=…` link once per process run. A failed notification is logged, and capture continues.

For systemd, save the real URL in `/etc/browsdr-runner.env` with `0600` permissions:

```ini
BROWSDR_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN
```

The service unit above already includes the optional `EnvironmentFile=-/etc/browsdr-runner.env`. After creating the file, run `sudo systemctl restart browsdr-runner`.

If RTL-SDR cannot be opened, check that the service account can access the USB device and that `dvb_usb_rtl28xxu` or another SDR program is not holding it. When the device is free, run `rtl_test -t` as the same account to distinguish driver and permission problems. [Debian RTL-SDR permission and driver notes](https://github.com/osmocom/rtl-sdr/blob/master/debian/README.Debian)

If the kernel reports a `device descriptor read` error and the device disappears, check USB status with `sudo journalctl -k -f` and `lsusb -t`. Try another port or a hub with stable power. The runner reconnects when the device reappears. If a physical reconnect must be done remotely, a hub with per-port power control can cycle power to only the SDR's port. [Linux USB error codes](https://docs.kernel.org/driver-api/usb/error-codes.html) · [uhubctl supported hubs and usage](https://github.com/mvp/uhubctl)
