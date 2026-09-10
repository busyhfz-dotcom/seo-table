import './globals.css';

export const metadata = {
  title: 'SEO Table',
  description: 'AI SEO Operating System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
