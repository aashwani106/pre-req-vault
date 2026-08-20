import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { PreReqVault } from "../target/types/pre_req_vault";
import {
  Commitment,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { BN } from "bn.js";
import { expect } from "chai";

const commitement: Commitment = "confirmed";

describe("pre-req-vault", () => {
  const confirmTx = async (signature: string) => {
    console.log(`Transaction signature: ${signature}`);
    const latestBlockhash = await anchor
      .getProvider()
      .connection.getLatestBlockhash();
    await anchor.getProvider().connection.confirmTransaction(
      {
        signature,
        ...latestBlockhash,
      },
      commitement
    );
  };

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.preReqVault as Program<PreReqVault>;
  const userKeypair = Keypair.generate();
  const user = userKeypair.publicKey;
  const github = "aashwani106";

  // Derive PDAs

  const [vaultStatePda, stateBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("state"), user.toBuffer()],
    program.programId
  );

  const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), vaultStatePda.toBuffer()],
    program.programId
  );

  before(async () => {
    const fundingTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: user,
        lamports: 2 * LAMPORTS_PER_SOL,
      })
    );

    const signature = await provider.sendAndConfirm(fundingTx);
    console.log(`Fund test wallet: ${signature}`);
  });

  after(async () => {
    const remainingBalance = await provider.connection.getBalance(user);

    if (remainingBalance > 0) {
      const cleanupTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: user,
          toPubkey: provider.wallet.publicKey,
          lamports: remainingBalance,
        })
      );

      const signature = await provider.sendAndConfirm(cleanupTx, [userKeypair]);
      console.log(`Reclaim test wallet: ${signature}`);
    }
  });

  it("Initialize the vault", async () => {
    const tx = await program.methods
      .initialize()
      .accountsStrict({
        user: user,
        vaultState: vaultStatePda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([userKeypair])
      .rpc();

    await confirmTx(tx);

    const vaultState = await program.account.vaultState.fetch(vaultStatePda);
    expect(vaultState.vaultBump).to.equal(vaultBump);
    expect(vaultState.stateBump).to.equal(stateBump);
  });

  it(" Deposilt 1 Sol in to the vault", async () => {
    const depositAmount = 1 * LAMPORTS_PER_SOL;

    const initialVaultBalance = await provider.connection.getBalance(vaultPda);
    const intialUserBalance = await provider.connection.getBalance(user);

    const tx = await program.methods
      .deposit(new BN(depositAmount))
      .accountsStrict({
        user: user,
        vaultState: vaultStatePda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([userKeypair])
      .rpc();

    await confirmTx(tx);

    const finalBalanceVault = await provider.connection.getBalance(vaultPda);
    const finalBalanceUser = await provider.connection.getBalance(user);

    expect(finalBalanceVault).to.equal(initialVaultBalance + depositAmount);
    expect(finalBalanceUser).to.equal(intialUserBalance - depositAmount);
  });

  it(" Withdraw 0.5 Sol from the vault", async () => {
    const withdrawAmount = 0.5 * LAMPORTS_PER_SOL;

    const initialVaultBalance = await provider.connection.getBalance(vaultPda);
    const intialUserBalance = await provider.connection.getBalance(user);

    const applicationProgram = new PublicKey(
      "TRBZyQHB3m68FGeVsqTK39Wm4xejadjVhP5MAZaKWDM"
    );

    const [applicationAccount, applicationBump] =
      PublicKey.findProgramAddressSync(
        [Buffer.from("prereqs"), user.toBuffer()],
        applicationProgram
      );

    const tx = await program.methods
      .withdraw(new BN(withdrawAmount), github)
      .accountsStrict({
        user: user,
        vaultState: vaultStatePda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
        applicationAccount,
        applicationProgram,
      })
      .signers([userKeypair])
      .rpc();

    await confirmTx(tx);

    const finalBalanceVault = await provider.connection.getBalance(vaultPda);
    const finalBalanceUser = await provider.connection.getBalance(user);
    const applicationAccountInfo = await provider.connection.getAccountInfo(
      applicationAccount
    );

    expect(finalBalanceVault).to.equal(initialVaultBalance - withdrawAmount);
    expect(finalBalanceUser).to.be.greaterThan(intialUserBalance);
    expect(applicationAccountInfo).to.not.be.null;
    expect(applicationAccountInfo!.owner.equals(applicationProgram)).to.be.true;

    const applicationData = applicationAccountInfo!.data;
    const applicationDiscriminator = Buffer.from([
      222, 181, 17, 200, 212, 149, 64, 88,
    ]);
    expect(applicationData.subarray(0, 8).equals(applicationDiscriminator)).to
      .be.true;

    const storedUser = new PublicKey(applicationData.subarray(8, 40));
    const storedBump = applicationData[40];
    const githubLength = applicationData.readUInt32LE(43);
    const storedGithub = applicationData
      .subarray(47, 47 + githubLength)
      .toString("utf8");

    expect(storedUser.equals(user)).to.be.true;
    expect(storedBump).to.equal(applicationBump);
    expect(storedGithub).to.equal(github);
  });

  it(" Close the vault and withdraw all the funds", async () => {
    const initialUserBalance = await provider.connection.getBalance(user);

    const tx = await program.methods
      .close()
      .accountsStrict({
        user: user,
        vaultState: vaultStatePda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([userKeypair])
      .rpc();

    await confirmTx(tx);

    expect(await provider.connection.getBalance(vaultPda)).to.equal(0);

    const vaultStateInfo = await provider.connection.getAccountInfo(
      vaultStatePda
    );
    expect(vaultStateInfo).to.be.null;

    const finalUserBalance = await provider.connection.getBalance(user);
    expect(finalUserBalance).to.be.greaterThan(initialUserBalance);
  });
});
