const path = require("path");

const workspaceNodeModules = path.resolve(__dirname, "../../node_modules");

module.exports = {
  dependencies: {
    "@react-native-async-storage/async-storage": {
      root: path.join(workspaceNodeModules, "@react-native-async-storage/async-storage"),
    },
    "@react-native-google-signin/google-signin": {
      root: path.join(workspaceNodeModules, "@react-native-google-signin/google-signin"),
    },
    "react-native-safe-area-context": {
      root: path.join(workspaceNodeModules, "react-native-safe-area-context"),
    },
  },
};
