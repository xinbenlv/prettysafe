import { useEffect, useRef } from 'react';
import jazzicon from '@metamask/jazzicon';

interface JazziconProps {
  address: string;
  diameter?: number;
  className?: string;
}

// Convert hex address to a seed number for jazzicon
function addressToSeed(address: string): number {
  const addr = address.startsWith('0x') ? address.slice(2) : address;
  // Use first 8 hex characters as seed (32 bits)
  return parseInt(addr.slice(0, 8), 16);
}

export default function Jazzicon({ address, diameter = 24, className = '' }: JazziconProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current && address) {
      // Clear previous icon
      containerRef.current.innerHTML = '';

      // Generate new jazzicon
      const seed = addressToSeed(address);
      const icon = jazzicon(diameter, seed);

      // Style the icon
      icon.style.borderRadius = '50%';

      containerRef.current.appendChild(icon);
    }
  }, [address, diameter]);

  return (
    <div
      ref={containerRef}
      className={`inline-flex items-center justify-center ${className}`}
      style={{ width: diameter, height: diameter }}
    />
  );
}
