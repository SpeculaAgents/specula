import { parseAbi, type Address } from "viem";

/** Contracts on Robinhood Chain the engine reads. All third-party; shapes checked against the live chain. */
export const ADDR = {
  ponsFactory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  ponsEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  ponsHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
} as const satisfies Record<string, Address>;

export const factoryAbi = parseAbi([
  "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
  "event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)",
]);
export const evLaunched = factoryAbi[1];
export const evGraduated = factoryAbi[2];

export const curveAbi = parseAbi([
  "function token() view returns (address)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)",
  "event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)",
]);
export const evBuy = curveAbi[2];
export const evSell = curveAbi[3];

export const poolManagerAbi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
]);
export const evInit = poolManagerAbi[0];
export const evSwap = poolManagerAbi[1];
export const evLiq = poolManagerAbi[2];

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
export const evTransfer = erc20Abi[5];

export const aggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export const PHASES = ["curve", "graduating", "pool", "rescued"] as const;
export const phaseName = (n: number) => PHASES[n] ?? "unknown";
