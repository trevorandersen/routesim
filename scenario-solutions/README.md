# Scenario solutions

Reference solutions for the built-in curriculum (`src/scenario-library.ts`), one
console script per scenario. Each script **loads** its scenario, **applies** the
fix, and **checks** the goal — paste it into the command console (the `>_` toolbar
button), or run it with `routesim.run(<contents>)`. Lines starting with `#` and
blank lines are ignored by the script runner.

These are the *tested* solutions: `tests/scenarios.test.ts` runs every script and
asserts the scenario starts unsolved and passes afterwards, so they cannot drift
from the curriculum. Editing a solution? Edit the script here — the test reads it.

| # | Scenario | Script |
|---|----------|--------|
| 1 | Connect a LAN | [`connect-lan.routesim.txt`](connect-lan.routesim.txt) |
| 2 | VLAN segmentation | [`vlan-segmentation.routesim.txt`](vlan-segmentation.routesim.txt) |
| 3 | Router on a stick | [`router-on-a-stick.routesim.txt`](router-on-a-stick.routesim.txt) |
| 4 | Static routes | [`static-routes.routesim.txt`](static-routes.routesim.txt) |
| 5 | DHCP service | [`dhcp-service.routesim.txt`](dhcp-service.routesim.txt) |
| 6 | RIP convergence | [`rip-convergence.routesim.txt`](rip-convergence.routesim.txt) |
| 7 | Firewall: allow SSH, block Telnet | [`firewall-guard.routesim.txt`](firewall-guard.routesim.txt) |
| 8 | Troubleshoot: broken gateway | [`troubleshoot-gateway.routesim.txt`](troubleshoot-gateway.routesim.txt) |
| 9 | Troubleshoot: wrong VLAN | [`troubleshoot-vlan.routesim.txt`](troubleshoot-vlan.routesim.txt) |
| 10 | Troubleshoot: overzealous firewall | [`troubleshoot-firewall.routesim.txt`](troubleshoot-firewall.routesim.txt) |
| 11 | Troubleshoot: bad static route | [`troubleshoot-static-route.routesim.txt`](troubleshoot-static-route.routesim.txt) |
| 12 | NAT gateway | [`nat-gateway.routesim.txt`](nat-gateway.routesim.txt) |
| 13 | Harden the gateway | [`harden-gateway.routesim.txt`](harden-gateway.routesim.txt) |
| 14 | Name service (DNS) | [`dns-service.routesim.txt`](dns-service.routesim.txt) |
| 15 | Troubleshoot: name vs address | [`troubleshoot-dns.routesim.txt`](troubleshoot-dns.routesim.txt) |
| 16 | DHCP from the server | [`server-dhcp.routesim.txt`](server-dhcp.routesim.txt) |
| 17 | Join a WiFi network | [`wifi-join.routesim.txt`](wifi-join.routesim.txt) |
| 18 | Troubleshoot: wrong WiFi password | [`troubleshoot-wifi.routesim.txt`](troubleshoot-wifi.routesim.txt) |
| 19 | WiFi hotspot + DHCP | [`wifi-dhcp.routesim.txt`](wifi-dhcp.routesim.txt) |
| 20 | 802.1X port authentication | [`port-auth-8021x.routesim.txt`](port-auth-8021x.routesim.txt) |
| 21 | MACsec the inter-switch trunk | [`macsec-link.routesim.txt`](macsec-link.routesim.txt) |
| 22 | Secure access (802.1X + MACsec) | [`secure-access.routesim.txt`](secure-access.routesim.txt) |
