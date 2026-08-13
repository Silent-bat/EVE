/**
 * Clear cached voice payloads written by pcmToWav. Called from logout so
 * a future device user (or a swap to a different account) can't replay
 * the previous user's responses from disk.
 *
 * Best-effort: failures are swallowed by the caller. expo-file-system
 * doesn't throw when the directory is empty or missing.
 */
import * as FileSystem from "expo-file-system/legacy";

export async function clearVoiceCache(): Promise<void> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return;
  const entries = await FileSystem.readDirectoryAsync(dir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((name) => name.startsWith("eve-voice-") && name.endsWith(".wav"))
      .map((name) =>
        FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(
          () => undefined,
        ),
      ),
  );
}
