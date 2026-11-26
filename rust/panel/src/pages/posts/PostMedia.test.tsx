import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tr from '@/i18n/tr.json';
import type { Cover } from '@/api/postsPage';
import { postRow } from '@/test/postsPage';
import { PostMedia } from './PostMedia';

const M = tr.postsPage.media;
const pic = (id: string, url: string): Cover => ({ material_id: id, mime: 'image/jpeg', preview_url: url, preview_expires_at: null, ai_generated: false });
const row = postRow('slot:m', { title: 'Örnek görsel' });

describe('PostMedia', () => {
  it('tries a picture again once a later read gives it a fresh address', () => {
    const { rerender } = render(<PostMedia row={row} materials={[pic('m1', '/old.jpg')]} loading={false} />);
    const media = screen.getByRole('region', { name: M.label });
    fireEvent.error(within(media).getByRole('img', { name: 'Örnek görsel' }));
    // The expired address: the placeholder, no broken image.
    expect(within(media).queryByRole('img', { name: 'Örnek görsel' })).not.toBeInTheDocument();
    rerender(<PostMedia row={row} materials={[pic('m1', '/fresh.jpg')]} loading={false} />);
    expect(within(media).getByRole('img', { name: 'Örnek görsel' })).toHaveAttribute('src', '/fresh.jpg');
  });

  it('shows the full-size picture from the current read, and says when it cannot be opened', async () => {
    const user = userEvent.setup();
    const slides = (v: string) => [pic('m1', `/a-${v}.jpg`), pic('m2', `/b-${v}.jpg`)];
    const { rerender } = render(<PostMedia row={row} materials={slides('1')} loading={false} />);
    await user.click(screen.getByRole('button', { name: `${M.slide.replace('{{n}}', '2').replace('{{count}}', '2')} · ${M.full}` }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: 'Örnek görsel' })).toHaveAttribute('src', '/b-1.jpg');
    // A refetch signs the files again: the open view follows the new address of the same slide.
    rerender(<PostMedia row={row} materials={slides('2')} loading={false} />);
    expect(within(dialog).getByRole('img', { name: 'Örnek görsel' })).toHaveAttribute('src', '/b-2.jpg');
    fireEvent.error(within(dialog).getByRole('img', { name: 'Örnek görsel' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent(M.failed);
    rerender(<PostMedia row={row} materials={slides('3')} loading={false} />);
    expect(within(dialog).getByRole('img', { name: 'Örnek görsel' })).toHaveAttribute('src', '/b-3.jpg');
  });
});
