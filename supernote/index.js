/**
 * Ephemeris plugin entry: one toolbar button in NOTE and DOC opens the task view.
 * @format
 */
import { AppRegistry, Image } from "react-native";
import App from "./App";
import { name as appName } from "./app.json";
import { PluginManager } from "sn-plugin-lib";

AppRegistry.registerComponent(appName, () => App);

PluginManager.init();

PluginManager.registerButton(1, ["NOTE", "DOC"], {
  id: 100,
  name: "Tasks",
  icon: Image.resolveAssetSource(require("./assets/icon.png")).uri,
  showType: 1,
});
