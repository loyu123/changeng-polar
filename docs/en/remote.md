> Split out of the [README](../../README.md) so the front page stays an introduction.

# Phone (remote access)

**There is no app.** Everything the phone can do lives in a single-file web page (`src/main/remote/mobile-page.ts` — no framework, no build step) that any browser can open. The reason is not laziness: a real APK means installing and updating separately on HarmonyOS / Android / iOS, for an interface that has exactly three states (pair / chat / disconnected).

Three ways to connect, pick by "do you need it away from home":

| Scenario | How | Cost |
|---|---|---|
| Same WiFi | Turn on LAN mode (bind `0.0.0.0`), open `http://<pc-ip>:7474` on the phone | Stops at the front door |
| Anywhere with internet | Install **Tailscale** on both PC and phone, same account, open `http://100.x.x.x:7474` | One client per side; traffic goes through an encrypted tunnel — no public exposure, no ports opened |
| Anywhere (the other route) | frp / your own tunnel | Needs a public VPS |

**Tailscale needs no configuration change**: once both ends are logged in, the address list in Settings gains a line labelled "Tailscale (works away from home)" with a 100.x address. It is recognised from `100.64.0.0/10` (RFC 6598) — no home or office LAN uses that range, so it cannot be mistaken for one. If you want HTTPS, `tailscale serve --bg 7474` lets the remote entry stay bound to loopback while Tailscale terminates TLS for the tailnet.

**Pairing is one-shot**: generate a 6-digit code on the PC, valid for 2 minutes, consumed on first use; the token that comes back is stored only as a sha256 hash. The device list is visible in Settings and each device can be revoked.

**"The phone can't connect" has a self-check**: Settings → Remote access → "Start self-check" walks the master switch, the bind address, LAN addresses, Tailscale, the firewall and the pairing state, each with a verdict and one next step. It holds the same line as the rest of this project: **state what can be determined, say "unknown" for what cannot**. The firewall is the latter case — Windows does not let a non-admin read whether a port has an allow rule (bulk `Get-NetFirewallPortFilter` returns AccessDenied, and asking rule by rule takes 33 seconds), so it reports "cannot confirm" plus the exact command to run, rather than a green tick that sends you looking elsewhere.

`npm run check:remote` is the half that needs no phone: it really binds `0.0.0.0` and walks ping / page / pairing / token-authenticated access / event stream / wrong-token rejection **over the LAN IP** (not loopback), then prints the same verdicts the self-check would. A loopback-only test can be all green while the phone still cannot connect; this separates the three causes (wrong bind address, loopback-only, inbound firewall).

**HarmonyOS note**: HarmonyOS 4.2 and earlier ship an AOSP compatibility layer and run APKs; **HarmonyOS NEXT (5.0+) is a pure HarmonyOS kernel and only accepts HAP packages**, so APKs will not install there. None of the three routes above needs an app, so this does not affect the phone workflow — only a future installable package would, and that means Capacitor wrapping the WebView on 4.2 versus a separate DevEco rewrite on NEXT.
