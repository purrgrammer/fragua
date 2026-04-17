// Type shim so TypeScript accepts `import styles from "./foo.module.css"`.
// Vite handles the actual transform at build time.

declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}
