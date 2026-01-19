import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImagePreview } from './ImagePreview';

describe('ImagePreview', () => {
  it('renders a data uri image when content is provided', () => {
    render(<ImagePreview content="ZGF0YQ==" filePath="image.png" />);
    const img = screen.getByRole('img', { name: 'image.png' });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'data:image/png;base64,ZGF0YQ==');
  });

  it('shows a fallback when content is empty', () => {
    render(<ImagePreview content="  " filePath="image.png" />);
    expect(screen.getByText('Image preview unavailable')).toBeInTheDocument();
  });

  it('does not render zoom controls', () => {
    render(<ImagePreview content="ZGF0YQ==" filePath="image.png" />);
    expect(screen.queryByTitle('Zoom in')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Zoom out')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Reset zoom')).not.toBeInTheDocument();
  });
});
