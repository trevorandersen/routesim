# RouteSim Improvements

## 1. Add Router to Toolbar
The rail has buttons for computer and switch but not router. Users can only get routers via config load. Add a router tool button to the rail so users can place routers directly on the canvas.

## 2. Subnet-Aware Ping (Routing Simulation)
Currently `devicesHavePath()` does a blind BFS across all links -- a ping between two PCs on different subnets succeeds as long as they're physically connected, even without a router. This undermines the educational value.

Fix: ping should check whether source and destination are on the same subnet. If they are, allow direct L2 reachability (through switches). If they aren't, the source must have a default gateway configured, that gateway must be a router interface on the source's subnet, and the router must have an interface on the destination's subnet. The path through switches to/from the router must also exist.

## 3. Switch MAC Table Learning
The switch `macTable` config field exists but is never populated during simulation. When a ping succeeds, switches along the path should learn the source MAC on the ingress port. This makes `show mac` on the switch terminal actually useful.

## 4. Router ARP Table Learning
Router interfaces have an `arpTable` field but routers never learn ARP entries when forwarding pings. When a router forwards a ping, it should learn the MAC of the source PC on the ingress interface and the MAC of the destination PC on the egress interface.

## 5. VLAN Enforcement
Managed switches support VLAN configuration but VLANs don't affect forwarding. Two PCs on different VLANs on the same switch can still ping each other. VLAN IDs should be checked during the L2 reachability walk so that ports on different VLANs are isolated.

## 6. Ping Undo Noise
A successful ping calls pushUndo() because it learns ARP entries. This fills the undo stack with states users don't care about reverting. Group ARP/MAC learning side effects so they don't each push an undo snapshot -- only push once for the whole ping operation.
