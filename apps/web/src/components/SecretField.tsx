import { TextField, type TextFieldProps } from '@isnanme/ui';
import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState, type CSSProperties } from 'react';

/** Browsers that can mask a text input (Chromium, Safari); elsewhere the value shows as typed. */
const canMask = typeof CSS !== 'undefined' && CSS.supports('-webkit-text-security', 'disc');

/**
 * A field for API keys and other secrets. It's a text input masked with CSS rather than a password
 * input, so browsers and password managers don't take the form for a sign-in (no saved password
 * offered for the field beside it, no "save password?"). The eye button shows what was pasted.
 */
export const SecretField = forwardRef<HTMLInputElement, Omit<TextFieldProps, 'type' | 'suffix'>>(function SecretField(
  { className, style, ...props },
  ref,
) {
  const [shown, setShown] = useState(false);
  const masked = canMask && !shown;
  return (
    <TextField
      ref={ref}
      {...props}
      type="text"
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
      className={`[&_input]:font-mono ${className ?? ''}`}
      style={{ ...style, WebkitTextSecurity: masked ? 'disc' : 'none' } as CSSProperties}
      suffix={
        canMask ? (
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? 'Hide' : 'Show'}
            aria-pressed={shown}
            className="-mr-1.5 flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:text-ink"
          >
            {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        ) : undefined
      }
    />
  );
});
