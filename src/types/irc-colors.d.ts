declare module 'irc-colors' {
  interface ColorFunction {
    (text: string): string;
  }

  const ircColors: {
    red: ColorFunction;
    green: ColorFunction;
    yellow: ColorFunction;
    blue: ColorFunction;
    purple: ColorFunction;
    cyan: ColorFunction;
    white: ColorFunction;
    gray: ColorFunction;
    lightgreen: ColorFunction;
    lightyellow: ColorFunction;
    lightblue: ColorFunction;
    pink: ColorFunction;
    orange: ColorFunction;
    lightgray: ColorFunction;
  };

  export = ircColors;
}
