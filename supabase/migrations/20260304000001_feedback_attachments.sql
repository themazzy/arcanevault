-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create feedback_attachments table
CREATE TABLE feedback_attachments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  feedback_id     UUID NOT NULL REFERENCES feedback (id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  user_email      TEXT,
  file_key        TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  file_size       BIGINT,
  file_name       TEXT,
  uploaded_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(feedback_id, file_key)
);

-- Create index for faster queries
CREATE INDEX idx_feedback_attachments_feedback_id ON feedback_attachments (feedback_id);

-- Allow authenticated users to insert their own attachments
CREATE POLICY authenticated_user_insert
  ON feedback_attachments
  FOR INSERT
  WITH CHECK (auth.uid() = user_id OR auth.uid() IS NULL);

-- Allow public read access to attachments
CREATE POLICY public_read_attachments
  ON feedback_attachments FOR SELECT
  USING (true);

-- Create storage bucket for assets
INSERT INTO storage.buckets (id, name, public)
VALUES ('assets', 'assets', false)
ON CONFLICT (id) DO NOTHING;

-- Grant storage usage to authenticated users
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets TO anon, authenticated;

-- Allow authenticated users to upload files
CREATE POLICY authenticated_user_upload
  ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'assets' AND auth.uid() IS NOT NULL);

-- Allow users to delete their own uploaded files
CREATE POLICY user_delete_own_files
  ON storage.objects
  FOR DELETE
  USING (bucket_id = 'assets' AND auth.uid() IS NOT NULL);

-- Allow public read access to uploaded files
CREATE POLICY public_read_assets
  ON storage.objects
  FOR SELECT
  USING (bucket_id = 'assets');
