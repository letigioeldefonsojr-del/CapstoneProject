// ====================================================================
// SUPABASE SETTINGS (the products database used by the Cashier)
// ----------------------------------------------------------------
// ENABLED = true  -> the Cashier finds products and deducts stock in Supabase.
// ENABLED = false -> the Cashier goes back to using Firebase for products
//                    (a one-line way to switch back if anything goes wrong).
// The publishable key is meant to be public (it is the same kind of key as
// the Firebase web config); what protects the data is the store-api function,
// which only accepts signed-in staff.
// ====================================================================
export const SUPABASE_ENABLED = true;
export const SUPABASE_URL = "https://jytrozeqqdyhzrafvfat.supabase.co";
export const SUPABASE_KEY = "sb_publishable_cl2ddz-5ZPYxjuqhls6AGQ_2eIuqpcK";
