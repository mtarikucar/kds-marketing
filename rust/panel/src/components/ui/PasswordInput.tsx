import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from './Input';
import { IconButton } from './IconButton';
import { cn } from './cn';

/** Keep password entry inspectable without losing the input's label or autocomplete. */
export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, disabled, ...props }, ref) => {
    const { t } = useTranslation();
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative min-w-0">
        <Input {...props} ref={ref} disabled={disabled} type={visible ? 'text' : 'password'} className={cn('pe-11', className)} />
        <IconButton
          aria-label={visible ? t('kit.hidePassword') : t('kit.showPassword')}
          aria-pressed={visible}
          disabled={disabled}
          size="sm"
          className="absolute end-0.5 top-0.5"
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </IconButton>
      </div>
    );
  },
);
PasswordInput.displayName = 'PasswordInput';
