// src/contractors/busyloop.ts: the zero-token fixture (DESIGN 11.4). Label: "SCRIPTED FIXTURE · trips on time cap".
// A managed process, never an exec with &. Main's run.ts arms the fuse with a 40 s time cap.
import type { Vm, VmHandle } from "../contracts.js";

export async function startBusyloop(vmApi: Vm, vm: VmHandle): Promise<string> {
  return vmApi.spawn(vm, "python3 -c 'while True: pass'", "/work");   // the managed process id
}
