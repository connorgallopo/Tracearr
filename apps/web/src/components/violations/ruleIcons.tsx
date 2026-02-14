import { MapPin, Users, Zap, Shield, Globe, Clock, HardDrive } from 'lucide-react';

/** Rule type → icon mapping for web. Uses h-4 w-4 by default; override at call site if needed. */
export const ruleIcons: Record<string, React.ReactNode> = {
  impossible_travel: <MapPin className="h-4 w-4" />,
  simultaneous_locations: <Users className="h-4 w-4" />,
  device_velocity: <Zap className="h-4 w-4" />,
  concurrent_streams: <Shield className="h-4 w-4" />,
  geo_restriction: <Globe className="h-4 w-4" />,
  account_inactivity: <Clock className="h-4 w-4" />,
  maximum_traffic: <HardDrive className="h-4 w-4" />,
};

/** Rule icons at 5x5 size for detail/header views */
export const ruleIconsLarge: Record<string, React.ReactNode> = {
  impossible_travel: <MapPin className="h-5 w-5" />,
  simultaneous_locations: <Users className="h-5 w-5" />,
  device_velocity: <Zap className="h-5 w-5" />,
  concurrent_streams: <Shield className="h-5 w-5" />,
  geo_restriction: <Globe className="h-5 w-5" />,
  account_inactivity: <Clock className="h-5 w-5" />,
  maximum_traffic: <HardDrive className="h-5 w-5" />,
};
