export interface GalleryImage {
  src: string;
  caption: string;
}

export interface CaseStudy {
  title: string;
  subtitle: string;
  copy: string;
  icon: { src: string; alt: string; variant?: 'icon' | 'logo' };
  badge: { label: string; href?: string };
  tags: string[];
  gallery: GalleryImage[];
}

export interface Milestone {
  label: string;
  title: string;
  date: string;
  copy: string;
}

export const caseStudies: CaseStudy[] = [
  {
    title: 'Ogrebuddy Ecosystem',
    subtitle: 'The Polished Flagship',
    copy: 'A character-driven browser tool for monitoring limited releases, scheduling actions, and controlling local or hosted browser agents from anywhere.',
    icon: { src: '/assets/buddy-purple.png', alt: 'Ogrebuddy' },
    badge: { label: 'Flagship' },
    tags: ['Browser extension', 'Remote PWA', 'WebSockets', 'Docker'],
    gallery: [
      { src: '/assets/screenshot-ogrebuddy.png', caption: 'Bodega Mode (Light)' },
      { src: '/assets/screenshot-ogrebuddy-neon.png', caption: 'Neon Storefront Mode (Dark)' },
    ],
  },
  {
    title: 'Ogredex',
    subtitle: 'The Complete Standalone Product',
    copy: 'A responsive Pokémon GO collection tracker for shinies, costumes, personal checklists, and shareable trading profiles.',
    icon: { src: '/assets/ogredex-logo.png', alt: 'Ogredex' },
    badge: { label: 'dex.myog.re →', href: 'https://dex.myog.re' },
    tags: ['React', 'FastAPI', 'SQLite', 'Public profiles'],
    gallery: [
      { src: '/assets/screenshot-ogredex.png', caption: 'Ogredex Shiny Collection Tracker' },
    ],
  },
  {
    title: 'MyOgre + Ogrebrain',
    subtitle: 'The Expanding Vision',
    copy: 'A developing personal assistant and virtual companion that brings together voice, schedules, travel information, weather, entertainment, and an extensible skills system.',
    icon: { src: '/assets/WEBLOGO.svg', alt: 'MyOgre and Ogrebrain', variant: 'logo' },
    badge: { label: 'Vision' },
    tags: ['SwiftUI', 'Voice', 'AI tools', 'Skills architecture'],
    gallery: [
      { src: '/assets/screenshot-myogre-ios.png', caption: 'MyOgre Native iOS Companion' },
      { src: '/assets/screenshot-ogrebrain-ops.png', caption: 'Ogrebrain Hub & Ops Console' },
    ],
  },
];

export const milestones: Milestone[] = [
  {
    label: 'Genesis',
    title: 'Cart Sniper',
    date: 'May 5, 2026',
    copy: 'Initial release monitoring experiment designed to track stock changes and manage checkout boundaries cleanly.',
  },
  {
    label: 'Evolution',
    title: 'Cart Sniper becomes Ogrebuddy',
    date: 'May 18, 2026',
    copy: 'Brand & character evolution introducing the original animated vector Ogre mascot rig and browser extension capabilities.',
  },
  {
    label: 'Mobile PWA',
    title: 'Remote Control through Ogrebite',
    date: 'Jun 2, 2026',
    copy: 'Mobile-first PWA controller allowing real-time monitoring and command relays to active shopping agents from any phone.',
  },
  {
    label: 'Headless Runner',
    title: 'Always-on Browser through Ogreview',
    date: 'Jun 16, 2026',
    copy: 'Headless browser agent runtime enabling background status checks and automated platform observations.',
  },
  {
    label: 'Central Hub',
    title: 'Ogrelord becomes Central Operations Hub',
    date: 'Jul 1, 2026',
    copy: 'Single source of truth server managing agent state, tasks, notifications, and real-time WebSocket command dispatch.',
  },
  {
    label: 'Personal Assistant',
    title: 'Ogrebrain expands into Personal Assistant',
    date: 'Jul 14, 2026',
    copy: 'Voice, schedule, travel, weather, and extensible skills system bringing personal assistant capabilities into the ecosystem.',
  },
  {
    label: 'iOS Flagship',
    title: 'MyOgre begins on iPhone',
    date: 'Jul 26, 2026',
    copy: 'Native Swift/SwiftUI flagship iOS controller application designed for direct companion interactions, widgets, and live activities.',
  },
  {
    label: 'Product Beta',
    title: 'Ogredex launches for Beta Testing',
    date: 'Aug 1, 2026',
    copy: 'Standalone Pokémon GO collection & trading checklist tool with public shareable profiles and checklist matching.',
  },
  {
    label: 'Ambient Future',
    title: 'Hardware Experiments Begin',
    date: 'Aug 5, 2026',
    copy: 'Exploring dedicated ambient physical hardware displays and interactive desk companions for the Ogre character.',
  },
];
