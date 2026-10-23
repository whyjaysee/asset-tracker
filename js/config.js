// Your Supabase project. The anon key is meant to be public: it can't read or change anything
// on its own. Access is controlled by sign-in and the nw_members list in the database.
window.NW_CONFIG = {
  supabaseUrl: 'https://yushkredjvgjmbnhnfsl.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl1c2hrcmVkanZnam1ibmhuZnNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NzIzMzAsImV4cCI6MjA5MDM0ODMzMH0.fncP0uG4_DB9xmeJMgqWDzvj15qcuUl5HQvU789xk60',
  // App key of the Saxo OpenAPI live app (PKCE). Public by design: PKCE apps have no secret, and
  // Saxo only returns to the redirect addresses registered with the app. Empty = Saxo sync off.
  saxoAppKey: '',
};
