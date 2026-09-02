import type { ComponentType } from 'react';
import {
  Image as ImageIcon, Wand2, Eraser, Film, Play, Users, ArrowLeftRight,
  FastForward, Maximize2, UserRound, Mic, AudioWaveform, Music, Volume2,
} from 'lucide-react';
import type { MediaTechnique, MediaSourceSlot } from '../../../features/marketing/api/media.service';

/**
 * How a technique is presented. The user's first choice is "what do you want to
 * make", NOT which model — so every entry is named after the JOB and described in
 * one plain sentence. Model names live one level down, in the tier picker, where
 * they are a price/quality choice rather than a vocabulary test.
 *
 * The keys are the backend's own MEDIA_TECHNIQUES enum; `order` is presentation
 * only. A technique the catalogue serves but this map does not describe still
 * renders (falling back to its enum key), so a new backend technique cannot
 * disappear from the UI — it just arrives unexplained until someone writes the
 * sentence.
 */
export interface TechniqueMeta {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  /** i18n default — the plain-language name of the job. */
  title: string;
  /** i18n default — one line on what it is FOR, never how it works. */
  desc: string;
}

export const TECHNIQUE_META: Record<MediaTechnique, TechniqueMeta> = {
  IMAGE_CREATE: {
    icon: ImageIcon,
    title: 'Create an image',
    desc: 'Make a picture from a description.',
  },
  IMAGE_EDIT: {
    icon: Wand2,
    title: 'Edit an image',
    desc: 'Change one thing and keep the rest — one product shot becomes a campaign.',
  },
  IMAGE_CLEANUP: {
    icon: Eraser,
    title: 'Clean up an image',
    desc: 'Cut out the background, enlarge it, or drop a product into a scene.',
  },
  VIDEO_CREATE: {
    icon: Film,
    title: 'Create a video',
    desc: 'Make a clip from a description.',
  },
  VIDEO_ANIMATE: {
    icon: Play,
    title: 'Animate a still',
    desc: 'Turn a photo you already have into a moving clip.',
  },
  VIDEO_REFERENCE: {
    icon: Users,
    title: 'Keep a character or product the same',
    desc: 'The same face or the same product across every shot.',
  },
  VIDEO_TRANSITION: {
    icon: ArrowLeftRight,
    title: 'Go from one frame to another',
    desc: 'Give the opening and closing frame; the move between them is made for you.',
  },
  VIDEO_EXTEND: {
    icon: FastForward,
    title: 'Continue a clip',
    desc: 'Carry an existing video on from where it stops.',
  },
  VIDEO_UPSCALE: {
    icon: Maximize2,
    title: 'Sharpen a video',
    desc: 'Finish a clip at delivery resolution.',
  },
  AVATAR: {
    icon: UserRound,
    title: 'A presenter reads your script',
    desc: 'Write the words and get a person on camera saying them.',
  },
  LIPSYNC: {
    icon: Mic,
    title: 'Match lips to a voice',
    desc: 'Make a face in an existing video speak a recording.',
  },
  VOICE: {
    icon: AudioWaveform,
    title: 'Voiceover',
    desc: 'Turn written text into a spoken Turkish voice track.',
  },
  MUSIC: {
    icon: Music,
    title: 'Music or a sound effect',
    desc: 'A background bed for a video, or one short effect.',
  },
  VIDEO_SOUND: {
    icon: Volume2,
    title: 'Add sound to a silent clip',
    desc: 'Generate matching sound and effects for a video that has none.',
  },
};

/**
 * What a source slot is CALLED to the user.
 *
 * Keyed by the provider parameter name rather than by `slot`, because the slot
 * alone is ambiguous: `firstImage` is "the source image" on an edit, "the opening
 * frame" on a first-frame→last-frame transition, and the face on a talking-head
 * avatar. The parameter name is what distinguishes them.
 */
export const SOURCE_LABELS: Record<string, { title: string; hint: string }> = {
  image_url: { title: 'Source image', hint: 'The picture this is made from.' },
  image_urls: { title: 'Source images', hint: 'Reference shots of the product or person to keep the same.' },
  start_image_url: { title: 'Opening frame', hint: 'The frame the clip starts on.' },
  end_image_url: { title: 'Closing frame', hint: 'The frame the clip ends on.' },
  video_url: { title: 'Source video', hint: 'The clip this works on.' },
  audio_url: { title: 'Voice track', hint: 'The recording the picture is driven by.' },
  mask_url: { title: 'Mask', hint: 'A black-and-white image marking the area to change.' },
};

/** Which asset type a slot takes — decides both what the library picker lists
 *  and what the file input will accept. */
export const SLOT_MEDIA_TYPE: Record<MediaSourceSlot, 'IMAGE' | 'VIDEO' | 'AUDIO'> = {
  images: 'IMAGE',
  firstImage: 'IMAGE',
  lastImage: 'IMAGE',
  mask: 'IMAGE',
  video: 'VIDEO',
  audio: 'AUDIO',
};
