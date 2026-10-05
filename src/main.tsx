import { applyTheme, loadTheme } from "./theme/themes";
import { installDesktopExternalLinkGuard } from "./ipc/client";
import "./index.css";

applyTheme(loadTheme());
installDesktopExternalLinkGuard();
void import("./boot");
