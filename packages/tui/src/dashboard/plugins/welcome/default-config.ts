export interface WelcomeConfig {
  enabled: boolean;
  style: 'full' | 'minimal';
  showAsciiArt: boolean;
  showHealth: boolean;
  showConfig: boolean;
}

export const defaultWelcomeConfig: WelcomeConfig = {
  enabled: true,
  style: 'full',
  showAsciiArt: true,
  showHealth: true,
  showConfig: true,
};
