import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/consistent-type-imports': 'error' } },
);
