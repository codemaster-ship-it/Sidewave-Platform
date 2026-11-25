export const plans = [
  { id: 'free', label: 'Free', cents: 0, features: ['Community and private profiles', 'Photo sharing and favorites', 'Free music and previews'] },
  { id: 'pro', label: 'Pro', cents: 900, features: ['Everything in Free', 'Full music catalog', 'Listening history'] },
  { id: 'studio', label: 'Studio', cents: 1900, features: ['Everything in Pro', 'High-resolution photo uploads', 'Up to 1,800 pixels per photo'] }
];

export const creditPacks = [
  { id: 'credits25', credits: 25, cents: 300 },
  { id: 'credits100', credits: 100, cents: 900 },
  { id: 'credits250', credits: 250, cents: 1900 }
];

export const features = [
  { id: 'listeningHistory', name: 'Listening history', description: 'Keep a private list of your recently played tracks.', plan: 'pro' },
  { id: 'highResUploads', name: 'High-resolution uploads', description: 'Publish photos up to 1,800 pixels on the longest edge.', plan: 'studio' }
];

export const tracks = [
  { id: 'afterglow', title: 'Afterglow', artist: 'Circuit Atlas', album: 'An Open Window', length: 28, credits: 0, artwork: 'dawn' },
  { id: 'night-transit', title: 'Night Transit', artist: 'Circuit Atlas', album: 'Soft Signals', length: 36, credits: 10, artwork: 'night' },
  { id: 'glass-horizon', title: 'Glass Horizon', artist: 'Sable Current', album: 'Soft Signals', length: 34, credits: 10, artwork: 'ridge' }
];

export const collection = [
  { id: 'lake', title: 'Still water', place: 'From the Moments collection', alt: 'A cabin and mountains reflected in a still lake' },
  { id: 'shore', title: 'The long way home', place: 'From the Moments collection', alt: 'Boats on a calm lake surrounded by mountains' },
  { id: 'ridge', title: 'Above the tree line', place: 'From the Moments collection', alt: 'Rocky mountains rising above a green valley' }
];

export function eligible(plan, minimum) {
  const rank = plans.findIndex(item => item.id === plan);
  const required = plans.findIndex(item => item.id === minimum);
  return rank !== -1 && required !== -1 && rank >= required;
}

export function canPlay(account, track) {
  return track.credits === 0 || eligible(account?.plan, 'pro') || Boolean(account?.unlocked?.includes(track.id));
}
