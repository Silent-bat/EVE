/**
 * Device-local settings — the ones that describe this phone, not this account.
 *
 * Appearance already lives in ThemeContext on the same reasoning: whether EVE
 * greets you on the home screen is a property of the device you're holding, so
 * it belongs in AsyncStorage rather than in the `Preferences` record the server
 * keeps. Nothing here needs to survive a reinstall, and none of it should
 * follow you onto a second device you'd want configured differently.
 *
 * Reads are async, so every value starts at its default and corrects itself a
 * frame later. That's fine for a section that is hidden by default — it appears
 * once, rather than flashing away on launch for the people who enabled it.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";

/**
 * Still `askDock` on disk, deliberately: this setting used to control a text
 * composer and now controls the microphone, but anyone who switched it on has
 * that choice stored under the old name. Renaming the key would silently turn it
 * back off for exactly the people who wanted it.
 */
const LISTEN_FROM_HOME_KEY = "eve.askDock";

/**
 * Whether the home screen listens.
 *
 * Off by default, and the default is the cautious one for a stronger reason than
 * it used to be: this now opens the microphone on launch, not a text box. Off is
 * the setting that can't surprise anyone who never opened settings.
 */
export function useListenFromHomeEnabled(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    void AsyncStorage.getItem(LISTEN_FROM_HOME_KEY).then((stored) => {
      if (stored === "1") setEnabled(true);
    });
  }, []);

  const set = useCallback((next: boolean) => {
    setEnabled(next);
    void AsyncStorage.setItem(LISTEN_FROM_HOME_KEY, next ? "1" : "0");
  }, []);

  return [enabled, set];
}
