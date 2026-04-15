import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.freecalling.app",
  appName: "Free Calling App",
  webDir: "dist",
  server: {
    androidScheme: "https"
  }
};

export default config;
