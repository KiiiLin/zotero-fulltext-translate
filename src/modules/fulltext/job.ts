import {
  alignTranslations,
  savedFor,
  saveTranslation,
  translationUnits,
  Paragraph,
  SavedTranslation,
  splitTranslationText,
  TranslationFile,
} from "./model";

export interface TranslationBackend {
  translate(text: string): Promise<{ result: string; service: string }>;
  save(file: TranslationFile): Promise<void | TranslationFile>;
  delay(): Promise<void>;
  isCurrent(): Promise<boolean>;
}

/** A serial, resumable job, separate from the upstream selection/history queue. */
export class ParagraphTranslationJob {
  public errors = new Map<string, string>();
  public busy = false;
  public stopping = false;
  private pending = new Map<string, Promise<void>>();
  private tail: Promise<void> = Promise.resolve();
  public changed: () => void = () => {};

  constructor(
    public paragraphs: Paragraph[],
    public file: TranslationFile,
    private backend: TranslationBackend,
    private chunkSize = 3000,
  ) {
    this.file = alignTranslations(file, paragraphs);
  }

  get completed() {
    return this.paragraphs.filter((p) => this.get(p)).length;
  }

  get(paragraph: Paragraph): SavedTranslation | undefined {
    const entry = this.file.blocks[paragraph.id];
    return entry?.source === paragraph.text ? entry : undefined;
  }

  stop() {
    this.stopping = true;
    this.changed();
  }

  translate(paragraph: Paragraph): Promise<void> {
    if (this.get(paragraph)) return Promise.resolve();
    const existing = this.pending.get(paragraph.id);
    if (existing) return existing;
    const operation = this.tail.then(async () => {
      if (this.stopping || this.get(paragraph)) return;
      this.errors.delete(paragraph.id);
      this.changed();
      try {
        if (!(await this.backend.isCurrent()))
          throw new Error(
            "Translation settings changed. Reopen full-text translation to continue.",
          );
        this.file = alignTranslations(this.file, [paragraph]);
        if (this.get(paragraph)) return;
        // New paragraphs are translated as a whole. If fragments were already
        // paid for, retain them verbatim and translate only the missing units.
        const fragments = translationUnits(this.file, paragraph);
        const units = fragments.some((part) => savedFor(this.file, part))
          ? fragments
          : [{ id: paragraph.id, text: paragraph.text }];
        for (const unit of units) {
          if (savedFor(this.file, unit)) continue;
          if (!(await this.backend.isCurrent()))
            throw new Error(
              "Translation settings changed. Reopen full-text translation to continue.",
            );
          const translated: string[] = [];
          let service = "";
          for (const part of splitTranslationText(unit.text, this.chunkSize)) {
            const response = await this.backend.translate(part);
            if (!response.result.trim())
              throw new Error("Translation returned empty text");
            translated.push(response.result);
            service = response.service;
            await this.backend.delay();
          }
          const entry: SavedTranslation = {
            source: unit.text,
            result: translated.join("\n"),
            service,
            updatedAt: new Date().toISOString(),
          };
          // Save each newly paid fragment before continuing, so retries never
          // discard or charge again for fragments saved before a failure.
          const next = saveTranslation(this.file, unit.id, entry);
          this.file = (await this.backend.save(next)) || next;
        }
        const aligned = alignTranslations(this.file, [paragraph]);
        if (aligned !== this.file)
          this.file = (await this.backend.save(aligned)) || aligned;
      } catch (error) {
        this.errors.set(paragraph.id, String(error));
        throw error;
      } finally {
        this.changed();
      }
    });
    const tracked = operation.finally(() => {
      this.pending.delete(paragraph.id);
    });
    this.pending.set(paragraph.id, tracked);
    this.tail = tracked.catch(() => {});
    return tracked;
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.stopping = false;
    this.changed();
    try {
      for (const paragraph of this.paragraphs) {
        if (this.stopping) break;
        // Stop on the first provider/storage failure to avoid repeated charged failures.
        await this.translate(paragraph);
      }
    } finally {
      this.busy = false;
      this.changed();
    }
  }
}
