import { registerRootComponent } from "expo";
import App from "./App";
import { silenceNativeDriverWarning } from "./lib/native-animation";

// Must run before any component mounts and starts an animation.
silenceNativeDriverWarning();

registerRootComponent(App);
