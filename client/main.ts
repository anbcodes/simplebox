import { Screen } from "./screen";
import { Shell } from "./shell";

const screen = new Screen(document.getElementById("root")!);
new Shell(screen).boot();
