import { useProjectStore } from '../stores/projectStore';
import { SPLIT_SUGGEST_SECONDS } from './splitting';

/** Offer to split when a long video has just become the project's video. Appending to a
 *  timeline that already has clips is building an edit, and is left alone. */
export function offerSplitIfLong(timelineWasEmpty: boolean) {
  const { currentProject, setSplitPrompt } = useProjectStore.getState();
  if (
    timelineWasEmpty &&
    currentProject &&
    !currentProject.part_index &&
    (currentProject.duration || 0) >= SPLIT_SUGGEST_SECONDS
  ) {
    setSplitPrompt(currentProject.id);
  }
}
