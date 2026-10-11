import { ease } from '@isnanme/ui';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { Logo } from './Logo';

/** pay's sign-in frame: logo on top, one narrow column, centred on wider screens. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center px-5 pt-[calc(1.25rem+var(--inset-top))] pb-5 sm:px-8">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-5 pt-4 pb-16 sm:items-center sm:pt-0">
        <motion.div
          className="w-full max-w-[400px]"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease }}
        >
          <h1 className="text-[28px] leading-tight font-bold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-[15px] text-muted">{subtitle}</p>
          <div className="mt-7">{children}</div>
          {footer && <p className="mt-6 text-center text-sm text-muted">{footer}</p>}
        </motion.div>
      </main>
    </div>
  );
}
