/**
 * Clear cached voice payloads written by the recorder and pcmToWav. Called from logout so
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
      .filter((name) => {
        const voiceName = name.startsWith("eve-voice-") || name.startsWith("recording-");
        const audioFile = /\.(wav|m4a|aac|caf|3gp|webm)$/i.test(name);
        return voiceName && audioFile;
      })
      .map((name) => FileSystem.deleteAsync(`${dir}${name}`, { idempotent: true }).catch(() => undefined)),
  );
}
